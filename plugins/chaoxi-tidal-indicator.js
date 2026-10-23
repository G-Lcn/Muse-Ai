(()=>{ 'use strict';
/*
 * 潮汐量化-潮汐指标（Wed-DP 外部插件）v1 校准版 CT001.2
 * id: wed-ind.chaoxi.tidal
 *
 * 定位（DESIGN.md）：只负责显示。本地不算信号、不存历史；信号由云端
 * 「潮汐量化-潮汐数据」组装器发布为公开 HTTPS 直链 JSON，本插件自行
 * fetch 后在分时主图 / K线主图打标记，并在分析面板给出当日列表。
 *
 * 本版按 Wed-DP V0.001.00038 正式接口合同（TIDAL-PLUGIN.md）逐项校准，
 * 并以 V38 单文件源码实证为准（下列均为 V38 源码可核事实）：
 * - 注册：window.__AGP_PLUGIN_BOOTSTRAP__.plugins.push(spec)；spec 为
 *   type:'plugin'，slots 取 CORE_SLOTS 内的 'chart.main.overlay' /
 *   'settings.plugin' / 'panel.analysis'；不声明 indicators、不用
 *   ctx.indicators.register（合同明示），不占 MA 选中槽。
 * - 权限（V38 PLUGIN_PERMISSIONS 词表内）：workspace.write（专属设置）、
 *   visual.marker + visual.interact（createMarkerLayer 与悬停）、
 *   ui.surface（ctx.ui.mount）、data.read（ctx.data.kline.visible 归一
 *   化日K锚点，合同提及该 API；无此权限 ctx.data 为 null）。
 * - requirements.contracts 按 V38 实际宿主版本：pluginHost 0.8.0 /
 *   visualHost 0.16.9 / uiSurfaceHost 1.16.0（coreSupports 门控）。
 * - activate(ctx)：ctx.workspace.get()/set({...}) 专属持久化；
 *   ctx.visual.createMarkerLayer({context:'main.intraday'|'main.kline',
 *   order:80}) 建双层；ctx.core.getContext() 取当前 symbol/period；
 *   ctx.resources.onCore('view.change') 感知切换、interval 管定时器。
 * - 标记格式（合同 + V38 sanitizeVisualItem 实证）：{time: 毫秒 epoch,
 *   value: 价格, shape, color, size, eventKey, tooltip(≤240 纯文本),
 *   interactive:true, hoverOnly:true}。宿主不保留 position/text，
 *   方向靠 shape（买 arrowUp 红 / 卖 arrowDown 绿）+ tooltip 文案表达；
 *   单层单次 setData ≤ 512 项（合同上限，本插件截断）。
 * - 通道：仅公开 HTTPS 直链 + CORS、插件自行 fetch、无鉴权、无令牌。
 */
const root=globalThis, raw=root.__AGP_PLUGIN_BOOTSTRAP__, bag=raw&&Array.isArray(raw.plugins)?raw:{schemaVersion:1,plugins:[]}; if(raw!==bag)root.__AGP_PLUGIN_BOOTSTRAP__=bag;

/* ---------------- 常量 ---------------- */
const ID='wed-ind.chaoxi.tidal', VER='CT001.2';
const CTX_INTRA='main.intraday', CTX_KLINE='main.kline';
const BUY='#ef5350';        // 买红（与做T标记先例一致）
const SELL='#26a69a';       // 卖绿（DESIGN 定 B 红 / S 绿）
const UNKNOWN_COLOR='#d98a2b';
const KIND_DAY='chaoxi-intraday-signals', KIND_INDEX='chaoxi-intraday-index';
const TZ='Asia/Shanghai';
const MAX_MARKERS=512;      // 合同：每层单次更新最多 512 项
const DEFAULT_SETTINGS=Object.freeze({
  sourceBaseUrl:'',        // 信号源基地址（公开 HTTPS 直链目录，含 index.json 与 YYYY-MM-DD.json）；默认空＝未配置，不拉取不报错
  refreshSec:60,           // 自动刷新间隔（秒），开盘时段内生效
  overlayEnabled:true,     // 标记总开关（②级；①级为 Host 插件全局启停）
  intradayEnabled:true,    // 分时层开关（③级）
  klineEnabled:true,       // K线层开关（③级）
  viewDate:''              // 正在查看的日期（''＝跟随今天/索引最新一日），翻历史时写入
});
const REFRESH_CHOICES=[30,60,120,300];

/* type 注册表（DESIGN 拓展条款）：登记文案；未知 type 走通用点 + note */
const TYPE_REGISTRY=Object.freeze({
  t_signal:      { label:'分时信号' },
  t_trade:       { label:'分时成交' },
  kline_signal:  { label:'K线信号' },
  kline_single:  { label:'K线单信号' },
  kline_combo:   { label:'K线组合' }
});

/* ---------------- 小工具 ---------------- */
const num=v=>{const x=Number(v);return Number.isFinite(x)?x:NaN};
const isNum=Number.isFinite;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const dtf=new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',weekday:'short'});
function shParts(ms){ const o={}; for(const p of dtf.formatToParts(new Date(ms))) o[p.type]=p.value; return o; }
function shDateStr(ms){ const p=shParts(ms); return `${p.year}-${p.month}-${p.day}`; }
function shTimeStr(ms){ const p=shParts(ms); return `${p.hour}:${p.minute}:${p.second}`; }
function todayStr(){ return shDateStr(Date.now()); }
/* 仅开盘时段：周一至周五 9:30-11:30、13:00-15:00（Asia/Shanghai） */
function isTradingNow(nowMs){
  const p=shParts(nowMs||Date.now());
  if(['Sat','Sun'].includes(p.weekday))return false;
  const mins=Number(p.hour)*60+Number(p.minute);
  return (mins>=570&&mins<=690)||(mins>=780&&mins<=900);
}
/* ISO 时间 → epoch 毫秒（信号 time 带 +08:00，直接 Date.parse；合同口径） */
const msOf=iso=>{const ms=Date.parse(String(iso||''));return Number.isFinite(ms)?ms:NaN};
/* 按周期把毫秒时间戳向下对齐到 bar 起点（以 +08:00 为界） */
function floorToBarMs(ms,periodMin){
  if(!isNum(ms))return NaN;
  const step=periodMin*60000, shifted=ms+8*3600000;
  return Math.floor(shifted/step)*step-8*3600000;
}

/* ---------------- 插件状态 ---------------- */
const state={
  ctx:null,
  settings:{...DEFAULT_SETTINGS},
  dates:[],               // index.json 给的可用日期（升序）
  envelope:null,          // 最近一次成功拉到的当日文件信封
  envelopeDate:'',        // envelope 对应日期
  generatedAt:'',         // envelope.generated_at（云端数据时间）
  fetchedAt:0,            // 最近一次成功拉取的本地时刻 ms
  stale:false,            // 拉取失败但保留旧数据 → 已过期
  lastError:'',           // 最近一次拉取失败原因（只进状态卡，不抛错）
  inflight:false,
  timerStop:null,         // ctx.resources.interval 的停止函数
  layers:{},              // context -> createMarkerLayer 返回层
  uiHandles:{},           // key -> ctx.ui.mount 句柄（按钮/状态卡）
  symbol:'',              // 当前股票代码（ctx.core.getContext().symbol）
  period:'',              // 当前宿主周期（time/day/m30/m5/...）
  disposed:false
};

/* ---------------- 设置（ctx.workspace 持久化，合同） ---------------- */
function loadSettings(ctx){
  let saved={};
  try{ saved=ctx?.workspace?.get?.()||{}; }catch(_){ saved={}; }
  const s={...DEFAULT_SETTINGS};
  if(typeof saved.sourceBaseUrl==='string')s.sourceBaseUrl=saved.sourceBaseUrl.trim();
  if(REFRESH_CHOICES.includes(Number(saved.refreshSec)))s.refreshSec=Number(saved.refreshSec);
  for(const k of ['overlayEnabled','intradayEnabled','klineEnabled']) if(typeof saved[k]==='boolean')s[k]=saved[k];
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(saved.viewDate||'')))s.viewDate=String(saved.viewDate);
  state.settings=s;
}
function saveSettings(){
  try{ state.ctx?.workspace?.set?.({...state.settings}); }catch(_){ /* 持久化失败不影响运行 */ }
}

/* ---------------- 文案 ---------------- */
function sideOf(sig){ return sig?.side==='sell'?'sell':'buy'; }
function tooltipOf(sig){
  const ms=msOf(sig.time);
  const p=isNum(ms)?shParts(ms):{hour:'--',minute:'--'};
  const dir=sideOf(sig)==='buy'?'买入':'卖出';
  const strength=isNum(num(sig.strength))?`｜强度 ${num(sig.strength)}`:'';
  const note=sig.note?`｜${sig.note}`:'';
  const src=sig.source||TYPE_REGISTRY[sig.type]?.label||'信号';
  return `${p.hour}:${p.minute} ${dir}｜价格 ${sig.price}｜来源 ${src}${strength}${note}`.slice(0,240);
}
/* 信号 → 合同 marker 对象 */
function toMarker(sig,anchorMs){
  const buy=sideOf(sig)==='buy';
  const known=Object.prototype.hasOwnProperty.call(TYPE_REGISTRY,sig.type);
  return {
    time:anchorMs,
    value:num(sig.price),
    shape:known?(buy?'arrowUp':'arrowDown'):'circle',   // 未知 type 通用点
    color:known?(buy?BUY:SELL):UNKNOWN_COLOR,
    size:10,
    eventKey:String(sig.id||''),
    tooltip:tooltipOf(sig),
    interactive:true,
    hoverOnly:true
  };
}

/* ---------------- 数据客户端（自行 fetch，不走 DataHub；合同） ---------------- */
function baseUrl(){ return String(state.settings.sourceBaseUrl||'').trim().replace(/\/+$/,''); }
async function fetchJson(url){
  const res=await fetch(url,{cache:'no-store'});
  if(!res||!res.ok)throw new Error(`HTTP ${res?res.status:'?'}`);
  return res.json();
}
/* 合同信封 {generated_at, signals[]}；我方组装器另带 kind/version，出现时必须相符 */
function validEnvelope(j,date){
  if(!j||typeof j!=='object'||!Array.isArray(j.signals))return null;
  if(j.kind&&j.kind!==KIND_DAY)return null;
  return { date:String(j.date||date), generated_at:String(j.generated_at||''), signals:j.signals };
}
/* index.json 给出可用日期列表：{dates:[...]} 或裸数组均可 */
function validIndex(j){
  const arr=Array.isArray(j)?j:(Array.isArray(j?.dates)?j.dates:null);
  if(!arr)return [];
  if(j&&!Array.isArray(j)&&j.kind&&j.kind!==KIND_INDEX)return [];
  return arr.filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(String(d))).map(String).sort();
}
/* 当前应显示的日期：手动翻历史优先 → 今天（若在索引里）→ 索引最新一日 → 今天 */
function targetDate(){
  const v=state.settings.viewDate;
  if(v)return v;
  const t=todayStr();
  if(!state.dates.length||state.dates.includes(t))return t;
  return state.dates[state.dates.length-1];
}
/*
 * 拉取一轮：先 index（尽力而为，失败不阻断当日文件），再当日文件。
 * 失败语义（DESIGN）：已有旧数据 → 保留旧标记 + stale 标过期；
 * 从未成功过 → 无标记、无报错，状态卡写明失败原因。
 */
async function refresh(reason){
  if(state.disposed||state.inflight)return;
  const base=baseUrl();
  if(!base){ state.lastError='未设置信号源'; renderAll(); return; }
  state.inflight=true;
  try{
    try{ const idx=await fetchJson(`${base}/index.json`); const ds=validIndex(idx); if(ds.length)state.dates=ds; }catch(_){ /* 索引失败不阻断 */ }
    const date=targetDate();
    const env=validEnvelope(await fetchJson(`${base}/${date}.json`),date);
    if(!env)throw new Error('信号文件格式不合规');
    state.envelope=env; state.envelopeDate=date;
    state.generatedAt=env.generated_at; state.fetchedAt=Date.now();
    state.stale=false; state.lastError='';
  }catch(e){
    state.lastError=String(e?.message||e||'拉取失败');
    if(state.envelope)state.stale=true;
  }finally{
    state.inflight=false;
    renderAll();
  }
}
/* 自动刷新：优先 ctx.resources.interval（宿主托管、停用自动清理） */
function startTimer(){
  stopTimer();
  const sec=Math.max(15,Number(state.settings.refreshSec)||60);
  const tick=()=>{
    if(state.disposed)return;
    if(state.settings.viewDate&&state.settings.viewDate!==todayStr())return;  // 看历史时不自动刷
    if(!isTradingNow())return;
    void refresh('auto');
  };
  try{
    const stop=state.ctx?.resources?.interval?.(tick,sec*1000);
    if(typeof stop==='function'){ state.timerStop=stop; return; }
  }catch(_){ /* 落到兜底 */ }
  const id=setInterval(tick,sec*1000);
  state.timerStop=()=>clearInterval(id);
  try{ state.ctx?.resources?.add?.(state.timerStop); }catch(_){ /* 靠 disposed 兜底 */ }
}
function stopTimer(){ if(state.timerStop){ try{state.timerStop()}catch(_){} state.timerStop=null; } }

/* ---------------- 当前视图（ctx.core.getContext，合同） ---------------- */
function syncView(){
  try{
    const v=state.ctx?.core?.getContext?.()||{};
    const sym=String(v.symbol||'');
    const per=String(v.period||'');
    const changed=(sym&&sym!==state.symbol)||(per&&per!==state.period);
    if(sym)state.symbol=sym;
    if(per)state.period=per;
    return changed;
  }catch(_){ return false; }
}

/* ---------------- 过滤与锚定 ---------------- */
/* 只收 confirmed；按 id 去重；只显示当前股票（code 与宿主 symbol 归一比较） */
function visibleSignals(){
  const env=state.envelope;
  if(!env)return [];
  const seen=new Set(), out=[];
  for(const sig of env.signals){
    if(!sig||typeof sig!=='object')continue;
    if(sig.status&&sig.status!=='confirmed')continue;
    const key=String(sig.id||`${sig.code}|${sig.time}|${sig.type}|${sig.side}`);
    if(seen.has(key))continue; seen.add(key);
    if(state.symbol&&String(sig.code||'').trim()!==state.symbol)continue;
    out.push(sig);
  }
  return out;
}
/* 日K锚点：用 ctx.data.kline.visible() 的实际 K 棒时间归一（合同） */
function dayBarMs(sig){
  const d=String(sig.date||'').slice(0,10)||shDateStr(msOf(sig.time));
  try{
    const rows=state.ctx?.data?.kline?.visible?.();
    if(Array.isArray(rows)){
      for(const r of rows){ const ts=num(r?.timestamp); if(isNum(ts)&&shDateStr(ts)===d)return ts; }
    }
  }catch(_){ /* data 不可用时落到日期零点锚，宿主会就近吸附 */ }
  const ms=Date.parse(`${d}T00:00:00+08:00`);
  return Number.isFinite(ms)?ms:NaN;
}
/* 信号锚点（毫秒）：分时按分钟对齐；K线按当前宿主周期取同周期信号，
   30m/5m 向下对齐 bar 起点，day 用 visible K 棒归一 */
function anchorFor(sig,context){
  const ms=msOf(sig.time);
  if(!isNum(ms))return NaN;
  if(context===CTX_INTRA)return floorToBarMs(ms,1);
  const period=String(sig.period||'day');
  if(period==='day')return dayBarMs(sig);
  if(period==='30m')return floorToBarMs(ms,30);
  if(period==='5m')return floorToBarMs(ms,5);
  return NaN;
}
/* K线层只画与当前宿主周期同周期的信号（time 模式下 K线层由宿主自动隐藏） */
function klinePeriodMatches(sig){
  const p=String(sig.period||'day');
  const host=state.period;
  if(!host||host==='time')return true;             // 宿主周期未知时不过滤
  if(host==='day')return p==='day';
  if(host==='m30'||host==='30m')return p==='30m';
  if(host==='m5'||host==='5m')return p==='5m';
  return p==='day';
}
function markersFor(context){
  const s=state.settings;
  if(!s.overlayEnabled)return [];
  if(context===CTX_INTRA&&!s.intradayEnabled)return [];
  if(context===CTX_KLINE&&!s.klineEnabled)return [];
  const wantChart=context===CTX_INTRA?'intraday':'kline';
  const list=[];
  for(const sig of visibleSignals()){
    if(String(sig.chart||'')!==wantChart)continue;
    if(context===CTX_KLINE&&!klinePeriodMatches(sig))continue;
    const t=anchorFor(sig,context);
    if(!isNum(t))continue;
    const m=toMarker(sig,t);
    if(!isNum(m.value))continue;
    list.push(m);
  }
  list.sort((a,b)=>a.time-b.time);
  return list.slice(0,MAX_MARKERS);
}

/* ---------------- 渲染 ---------------- */
function renderMarkers(){
  for(const context of [CTX_INTRA,CTX_KLINE]){
    const layer=state.layers[context];
    if(!layer)continue;
    try{ layer.setData(markersFor(context)); }catch(_){ /* 单层失败不影响另一层 */ }
  }
}
function statusSegments(){
  const s=state.settings;
  const date=state.envelopeDate||targetDate();
  const segs=[];
  if(!baseUrl())segs.push({text:`${date} 未设置信号源`});
  else if(!state.envelope)segs.push({text:`${date} ${state.lastError?`拉取失败 ${state.lastError}`:'加载中'}`});
  else{
    const gen=state.generatedAt?shTimeStr(Date.parse(state.generatedAt)):'--';
    const got=state.fetchedAt?shTimeStr(state.fetchedAt):'--';
    segs.push({text:`${date} 数据${gen} 拉取${got}${state.stale?' 已过期':''}`});
  }
  if(!s.overlayEnabled)segs.push({text:'标记总开关 关'});
  const rows=visibleSignals().slice().sort((a,b)=>msOf(a.time)-msOf(b.time));
  for(const sig of rows.slice(0,6)){
    const ms=msOf(sig.time);
    const pp=isNum(ms)?shParts(ms):{hour:'--',minute:'--'};
    const tag=sig.chart==='intraday'?'分时':(sig.period==='day'?'日K':sig.period);
    segs.push({text:`${pp.hour}:${pp.minute} ${sideOf(sig)==='buy'?'买':'卖'} ${sig.price} ${sig.source||''} ${tag}`.slice(0,48)});
  }
  if(state.envelope&&rows.length===0)segs.push({text:'当日无信号'});
  else if(rows.length>6)segs.push({text:`共 ${rows.length} 条`});
  return segs;
}
function renderStatus(){
  const card=state.uiHandles.status;
  if(card){ try{ card.update?.({segments:statusSegments()}); }catch(_){ /* 状态卡更新失败不影响标记 */ } }
}
function renderAll(){ renderMarkers(); renderStatus(); refreshToggleLabels(); }

/* ---------------- UI（ctx.ui.mount：settings.plugin + panel.analysis，合同） ---------------- */
function mountUi(spec){
  try{ return state.ctx?.ui?.mount?.(spec)||null; }catch(_){ return null; }
}
function refreshToggleLabels(){
  const s=state.settings;
  const map={
    toggle:`标记总开关：${s.overlayEnabled?'开':'关'}`,
    intra:`分时标记：${s.intradayEnabled?'开':'关'}`,
    kline:`K线标记：${s.klineEnabled?'开':'关'}`,
    interval:`刷新间隔：${s.refreshSec}秒`,
    date:`信号日期：${targetDate()}`
  };
  for(const k of Object.keys(map)){
    const h=state.uiHandles[k];
    if(h){ try{ h.update?.({label:map[k]}); }catch(_){} }
  }
}
function setupUi(){
  const add=(key,slot,label,order,onAction)=>{
    const h=mountUi({slot,kind:'button',label,order,onAction});
    if(h)state.uiHandles[key]=h;
    return h;
  };
  add('source','settings.plugin','潮汐信号源 URL',41,()=>{
    const cur=state.settings.sourceBaseUrl;
    let v=null;
    try{ v=typeof root.prompt==='function'?root.prompt('潮汐信号源基地址（公开 HTTPS 直链目录，含 index.json 与 YYYY-MM-DD.json）',cur):null; }catch(_){ v=null; }
    if(typeof v==='string'){ state.settings.sourceBaseUrl=v.trim(); saveSettings(); void refresh('manual'); }
  });
  add('refresh','settings.plugin','潮汐信号 刷新',42,()=>{ void refresh('manual'); });
  add('toggle','settings.plugin','标记总开关：开',43,()=>{ state.settings.overlayEnabled=!state.settings.overlayEnabled; saveSettings(); renderAll(); });
  add('intra','settings.plugin','分时标记：开',44,()=>{ state.settings.intradayEnabled=!state.settings.intradayEnabled; saveSettings(); renderAll(); });
  add('kline','settings.plugin','K线标记：开',45,()=>{ state.settings.klineEnabled=!state.settings.klineEnabled; saveSettings(); renderAll(); });
  add('interval','settings.plugin','刷新间隔：60秒',46,()=>{
    const i=REFRESH_CHOICES.indexOf(state.settings.refreshSec);
    state.settings.refreshSec=REFRESH_CHOICES[(i+1)%REFRESH_CHOICES.length];
    saveSettings(); startTimer(); refreshToggleLabels();
  });
  add('datePrev','settings.plugin','信号日期 上一日',47,()=>stepDate(-1));
  add('date','settings.plugin','信号日期：今日',48,()=>{ state.settings.viewDate=''; saveSettings(); void refresh('manual'); });
  add('dateNext','settings.plugin','信号日期 下一日',49,()=>stepDate(1));
  add('refreshPanel','panel.analysis','潮汐信号 刷新',21,()=>{ void refresh('manual'); });
  const card=mountUi({slot:'panel.analysis',kind:'stat-card',order:22,title:'今日信号',segments:[{text:'潮汐：未获取信号'}]});
  if(card)state.uiHandles.status=card;
  refreshToggleLabels();
}
/* 按 index 在可用日期间翻日；无 index 时按自然日步进 */
function stepDate(dir){
  const cur=targetDate();
  if(state.dates.length){
    let i=state.dates.indexOf(cur);
    if(i<0)i=dir>0?state.dates.filter(d=>d>cur).length-1:state.dates.filter(d=>d<cur).length-1;
    if(i<0)i=dir>0?0:state.dates.length-1;
    const next=state.dates[clamp(i+dir,0,state.dates.length-1)];
    if(next)state.settings.viewDate=next===todayStr()?'':next;
  }else{
    const ms=Date.parse(`${cur}T00:00:00+08:00`)+dir*86400000;
    state.settings.viewDate=shDateStr(ms);
  }
  saveSettings(); void refresh('manual');
}

/* ---------------- activate（合同示例结构） ---------------- */
function activate(ctx){
  state.ctx=ctx; state.disposed=false;
  loadSettings(ctx);
  syncView();
  /* 双主图独立标记层（合同 createMarkerLayer；拿不到时该层不渲染，不抛错） */
  for(const context of [CTX_INTRA,CTX_KLINE]){
    try{
      const layer=ctx?.visual?.createMarkerLayer?.({context,order:80});
      if(layer&&typeof layer.setData==='function')state.layers[context]=layer;
    }catch(_){ /* 权限/宿主差异时静默降级 */ }
  }
  setupUi();
  /* 视图变化：重绑 + 按新 symbol/period 重新投影（合同示例） */
  const onView=()=>{
    if(state.disposed)return;
    const changed=syncView();
    for(const context of [CTX_INTRA,CTX_KLINE]){ try{ state.layers[context]?.rebind?.(); }catch(_){} }
    if(changed)renderAll(); else renderMarkers();
  };
  for(const ev of ['view.change','view.ready']){
    try{ ctx?.resources?.onCore?.(ev,onView); }catch(_){ /* 事件缺失不阻断 */ }
  }
  startTimer();
  void refresh('init');   // 首拉不受开盘时段限制：先把今天/最新一日显示出来
  /* 清理函数（合同示例返回 cleanup；宿主另按 owner 自动回收层与 UI） */
  return ()=>{
    state.disposed=true;
    stopTimer();
    for(const context of [CTX_INTRA,CTX_KLINE]){ try{ state.layers[context]?.remove?.(); }catch(_){} }
    for(const k of Object.keys(state.uiHandles)){ try{ state.uiHandles[k]?.remove?.(); }catch(_){} }
    state.layers={}; state.uiHandles={};
  };
}

/* ---------------- spec（合同最小示例结构） ---------------- */
bag.plugins.push({
  id:ID,
  name:'潮汐量化-潮汐指标',
  version:VER,
  type:'plugin',
  autostart:true,
  slots:['chart.main.overlay','settings.plugin','panel.analysis'],
  permissions:['workspace.write','visual.marker','visual.interact','ui.surface','data.read'],
  requirements:{
    contracts:{ pluginHost:'0.8.0', visualHost:'0.16.9', uiSurfaceHost:'1.16.0' },
    indicatorContexts:[CTX_INTRA,CTX_KLINE]
  },
  activate
});
})();
