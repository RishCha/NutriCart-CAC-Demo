// Run: node tests/uat_demo_catalog.mjs [http://127.0.0.1:5000]
// An explicit URL tests the existing listener without starting or stopping Flask.
// Uses installed Edge and Python, with an isolated browser profile and database.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {existsSync} from "node:fs";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {createServer} from "node:net";
import {get} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";

const root = process.cwd();
const edgePath = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
assert(existsSync(edgePath), "Set EDGE_PATH to your installed Microsoft Edge executable.");
const pythonPath = path.join(root, ".venv", "Scripts", "python.exe");
const runtime = await mkdtemp(path.join(tmpdir(), "nutricart-location-planning-"));
const artifacts = path.join(root, "instance", "release-review");
await mkdir(artifacts, {recursive: true});
const profile = path.join(runtime, "edge-profile");
let edge, server, socket;
let nextId = 0;
let serverOutput = "";
const pending = new Map();
const browserErrors = [];

function localGet(url) {
  return new Promise((resolve, reject) => {
    const request = get(url, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({status: response.statusCode, body}));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(3000, () => request.destroy(new Error("Local HTTP timeout")));
  });
}

async function until(check, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

function cdp(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 90000);
    pending.set(id, {resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }});
    socket.send(JSON.stringify({id, method, params}));
  });
}

async function evaluate(expression) {
  const response = await cdp("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
  assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
  return response.result.value;
}

try {

  const externalUrl = process.argv[2];
  const port = externalUrl ? Number(new URL(externalUrl).port) : await freePort();
  const url = externalUrl || `http://127.0.0.1:${port}`;
  assert.equal(new URL(url).hostname, '127.0.0.1', 'UAT must use the local NutriCart server');
  if (!externalUrl) {
  server = spawn(pythonPath, ["-B", "-m", "flask", "--app", "app", "run", "--host", "127.0.0.1", "--port", String(port), "--no-reload"], {
    cwd: root, windowsHide: true,
    env: {...process.env, VERCEL: "1", NUTRICART_CATALOG_MODE: "demo", NUTRICART_DATABASE: path.join(runtime, "accounts.db"), FLASK_DEBUG: "0", PYTHONDONTWRITEBYTECODE: "1",
      PYTHON_DOTENV_DISABLED: "1", FLASK_SKIP_DOTENV: "1", NUTRICART_FEEDBACK_TO: ""},
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", chunk => { serverOutput += chunk; });
  server.stderr.on("data", chunk => { serverOutput += chunk; });
  }
  await until(async () => { try { return (await localGet(url)).status === 200; } catch { return false; } }, "Flask readiness");
  for (const asset of ['app.js','settings.js','grocery.js','styles.css','budget_tracker.js','feedback.js','meal_plan.js']) {
    const served=await localGet(url+'/static/'+asset+'?verify=localhost-store-flow');
    assert.equal(served.status,200);
    assert.equal(served.body,await readFile(path.join(root,'static',asset),'utf8'),'Fresh server must serve current '+asset);
  }

  edge = spawn(edgePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"],
  {windowsHide: true, stdio: "ignore"});
  const debugPort = await until(async () => {
    try { return Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]); }
    catch { return false; }
  }, "Edge debugging endpoint");
  const pages = JSON.parse((await localGet(`http://127.0.0.1:${debugPort}/json/list`)).body);
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id); pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") browserErrors.push(message.params.exceptionDetails);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") browserErrors.push(message.params.args);
  });
  await once(socket, "open");
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  const version = await cdp("Browser.getVersion");
  console.log(`Browser: ${version.userAgent}`);
  await cdp("Emulation.setLocaleOverride", {locale: "en-US"});
  await cdp("Emulation.setDeviceMetricsOverride", {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});
  await cdp("Page.navigate", {url});
  await until(() => evaluate("document.readyState === 'complete' && Boolean(window.NutriCartSettings)"), "application scripts");




  const checks=[], assets=[], lockedCardMetrics={};
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Network.responseReceived' && m.params.response.url.includes('/static/')) assets.push({url:new URL(m.params.response.url).pathname,status:m.params.response.status});});
  await cdp('Network.enable');await cdp('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp('Page.reload',{ignoreCache:true});await until(()=>evaluate("document.readyState==='complete' && Boolean(window.NutriCartSettings)"),'scripts after hard refresh');
  const check=(value,name)=>{assert(value,name);checks.push(name);console.log('PASS:',name);};
  async function click(selector){
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await delay(150);
    const box=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});await delay(500);
  }
  const fill=values=>evaluate(`(()=>{for(const [id,value] of Object.entries(${JSON.stringify(values)})){const n=document.getElementById(id);n.value=value;n.dispatchEvent(new Event('input',{bubbles:true}));}})()`);

  const layouts=[];
  async function layout(selector,name){
    for(const [width,height] of [[1920,1080],[1440,900],[1366,768],[1280,800],[1024,768],[768,1024],[390,844],[320,740]]) for(const size of ['normal','large','extra-large']) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<=390});
      await evaluate(`NutriCartSettings.setSetting('textSize',${JSON.stringify(size)})`);await delay(100);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start',behavior:'instant'})`);await delay(120);
      const state=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return {overflow:document.documentElement.scrollWidth>innerWidth+1,clipped:[...n.querySelectorAll('button,input,select')].filter(x=>x.getClientRects().length && ((x.tagName!=='INPUT' && x.scrollWidth>x.clientWidth+3) || x.getBoundingClientRect().right>innerWidth+1)).map(x=>x.id)}})()`);
      if(name==='store-results') {
        assert(await evaluate("(()=>{const c=document.querySelector('.store-card.is-selected').getBoundingClientRect(),b=document.querySelector('#snap-build-basket').getBoundingClientRect();return b.left>=c.left && b.right<=c.right && b.bottom<=c.bottom && getComputedStyle(document.querySelector('[name=snap_store]')).visibility==='visible'})()"),JSON.stringify({width,size}));
      }
      if(name==='planner-before' && width>=1024) {
        const grouping=await evaluate("(()=>{const r=n=>document.querySelector(n).getBoundingClientRect(),c=r('.planner-card'),b=r('#review-plan'),s=r('#review-settings'),fields=['.feasibility-fields .input-prefix','#people','#days'].map(r);return {card:c.width,center:Math.abs(c.x+c.width/2-document.documentElement.clientWidth/2),button:b.width,actionCenter:Math.abs(b.x+b.width/2-c.x-c.width/2),secondaryBelow:s.top>=b.bottom,fieldsAligned:Math.max(...fields.map(r=>r.top))-Math.min(...fields.map(r=>r.top))<2,heights:fields.map(r=>r.height)}})()");
        assert(grouping.card<=901 && grouping.center<2 && grouping.button<=341 && grouping.actionCenter<2 && grouping.secondaryBelow && grouping.fieldsAligned && Math.max(...grouping.heights)-Math.min(...grouping.heights)<2,JSON.stringify({width,size,grouping}));
      }
      if(name==='planner-before' && size==='normal') {
        const metrics=await cdp('Page.getLayoutMetrics');
        const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width,height:metrics.cssContentSize.height,scale:1}});
        await writeFile(path.join(artifacts,'desktop-polish-planner-'+width+'.png'),Buffer.from(shot.data,'base64'));
      }
      if(['planner-locked','meal-empty','budget-locked'].includes(name) && width===1440 && size==='normal') {
        const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await writeFile(path.join(artifacts,name+'-desktop.png'),Buffer.from(shot.data,'base64'));
      }
      if(name==='shopping') {
        const order=await evaluate(`(()=>{const b=document.querySelector('#budget-balance-card').getBoundingClientRect(),l=document.querySelector('#shopping-list-panel').getBoundingClientRect(),a=document.querySelector('#additional-purchases').getBoundingClientRect();return {balance:b.top,list:l.top,bottom:b.bottom,additional:a.top,listBottom:l.bottom}})()`);
        assert(order.additional>=order.listBottom-1,JSON.stringify({width,size,order}));
        if(width<=850) assert(order.list>=order.bottom && order.list-order.bottom<25,JSON.stringify({width,size,order}));
      }
      assert(!state.overflow && !state.clipped.length,JSON.stringify({name,width,size,state}));layouts.push({name,width,size});if(width===390 && size==='extra-large'){const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(artifacts,name+'-390.png'),Buffer.from(shot.data,'base64'));}
    }
    await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await evaluate("NutriCartSettings.setSetting('textSize','normal')");
  }
  await evaluate("NutriCartSettings.setSetting('cursorEffects',false);document.addEventListener('nutricart:plan-updated',e=>window.task16Plan={context:e.detail.context,result:e.detail.result})");
  check(await evaluate("document.querySelectorAll('.hero-actions button').length===1 && document.querySelector('#hero-find-snap').textContent===\"Let's get started\""),'Home unchanged');
  check(await evaluate("document.querySelector('#home-button svg') && document.querySelector('.footer-brand svg') && document.querySelector('link[rel=icon]').href.startsWith('data:image/svg+xml')"),'Original basket logo in header footer and favicon');
  check(await evaluate("!document.querySelector('#sign-in-form') && !document.querySelector('#create-account-form') && !document.querySelector('#forgot-password-form') && [...document.querySelectorAll('#save-grocery-plan,#save-meal-plan,#save-shopping-list')].every(n=>n.hidden)"),'Public demo omits authentication forms and cloud-save prompts');
  for(const [width,size] of [[1440,'normal'],[390,'extra-large'],[320,'extra-large']]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<=390});
    await evaluate(`NutriCartSettings.setSetting('textSize',${JSON.stringify(size)})`);await delay(100);
    await click('#account-button');
    const guestState=await evaluate("(()=>{const d=document.querySelector('#account-dialog'),r=d.getBoundingClientRect();return {visible:!d.hidden,focus:document.activeElement.id,bounds:[r.left,r.right,innerWidth],scroll:[d.scrollWidth,d.clientWidth],title:document.querySelector('#demo-account-title').textContent}})()");
    check(guestState.visible && guestState.focus==='continue-as-guest' && guestState.bounds[0]>=0 && guestState.bounds[1]<=guestState.bounds[2] && guestState.scroll[0]<=guestState.scroll[1]+1 && guestState.title==="Saved accounts aren’t available in this demo",'Guest account explanation fits '+width+' '+size+' '+JSON.stringify(guestState));
    await click('#continue-as-guest');
    check(await evaluate("document.querySelector('#account-dialog').hidden && document.activeElement.id==='account-button'"),'Continue as Guest closes and restores focus '+width);
  }
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await evaluate("NutriCartSettings.setSetting('textSize','normal')");
  await click('#account-button');
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  check(await evaluate("document.querySelector('#account-dialog').hidden && document.activeElement.id==='account-button'"),'Guest account panel supports Escape and focus restoration');
  check(await evaluate("!document.querySelector('#feedback-dialog').open"),'Feedback never opens automatically');
  await click('#feedback-desktop');
  check(await evaluate("document.querySelector('#feedback-title').textContent==='How was your NutriCart experience?' && document.querySelector('#feedback-form').hidden && document.querySelectorAll('#feedback-rating button').length===2"),'Feedback stage one shows only thumb choices');
  await click('[data-rating=positive]');
  check(await evaluate("document.querySelector('#feedback-title').textContent==='What did you like about NutriCart?' && document.querySelector('#feedback-submit').disabled"),'Positive question and unconfigured delivery disabled');
  await click('#feedback-back');await evaluate("document.querySelector('[data-rating=negative]').focus()");
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});

  check(await evaluate("document.querySelector('#feedback-title').textContent==='What could we improve?'"),'Negative question is conditional');
  for(const width of [1440,768,390,320]) for(const size of ['normal','large','extra-large']) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<=390});
    await evaluate(`NutriCartSettings.setSetting('textSize',${JSON.stringify(size)})`);await delay(100);
    check(await evaluate("(()=>{const d=document.querySelector('#feedback-dialog'),r=d.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && d.scrollWidth<=d.clientWidth+1})()"),'Feedback fits '+width+' '+size);
    if(width===390 && size==='extra-large') {const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(artifacts,'feedback-390.png'),Buffer.from(shot.data,'base64'));}

  }
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  check(await evaluate("!document.querySelector('#feedback-dialog').open && document.querySelector('#feedback-desktop').getClientRects().length===0 && document.querySelector('#feedback-mobile').getClientRects().length>0"),'Escape dismisses; mobile uses footer only');
  await click('#feedback-mobile');
  for(let tab=0;tab<8;tab++) {await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});}
  check(await evaluate("document.querySelector('#feedback-dialog').contains(document.activeElement)"),'Keyboard focus stays within the open native dialog');
  await click('#feedback-close');
  check(await evaluate("document.activeElement.id==='feedback-mobile'"),'Closing restores focus to mobile launcher');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await evaluate("NutriCartSettings.setSetting('textSize','normal')");
  // Controlled transport fixtures never send email. Backend SMTP tests separately verify acknowledgement and TLS.
  await evaluate(`window.feedbackRealFetch=window.fetch;window.feedbackPosts=[];window.feedbackOutcome='fail';window.fetch=(url,opts)=>{
    if(url==='/api/feedback') {
      if(opts?.method==='POST') {window.feedbackPosts.push(JSON.parse(opts.body));return new Promise(resolve=>setTimeout(()=>resolve(new Response(JSON.stringify(window.feedbackOutcome==='ok'?{delivered:true}:{error:'Delivery failed.'}),{status:window.feedbackOutcome==='ok'?200:502})),300));}
      return Promise.resolve(new Response(JSON.stringify({enabled:true,csrf_token:'test-token'}),{status:200}));
    }
    return window.feedbackRealFetch(url,opts);
  }`);
  await click('#feedback-desktop');await click('[data-rating=positive]');await fill({'feedback-comment':'Useful tools'});
  await evaluate("document.querySelector('#feedback-form').requestSubmit();document.querySelector('#feedback-form').requestSubmit()");await delay(500);
  check(await evaluate("window.feedbackPosts.length===1 && document.querySelector('#feedback-thanks').hidden && document.querySelector('#feedback-comment').value==='Useful tools'"),'Duplicate submit blocked; failed delivery retains draft without thanks');
  await evaluate("window.feedbackOutcome='ok'");await click('#feedback-submit');
  check(await evaluate("!document.querySelector('#feedback-thanks').hidden && document.querySelector('#feedback-thanks').textContent==='Thanks for helping us improve NutriCart!' && document.querySelector('#feedback-form').hidden"),'Thanks only after acknowledged delivery');
  check(await evaluate("window.feedbackPosts.every(p=>Object.keys(p).sort().join(',')==='comment,rating') && document.querySelector('#feedback-comment').value===''"),'Feedback sends no shopping metadata and clears delivered comment');
  await click('#feedback-close');await evaluate('window.fetch=window.feedbackRealFetch');
  await click('#planner-tab');
  check(await evaluate("document.querySelector('#planner-form').hidden && document.querySelector('#planner-view .planner-card').hidden && !document.querySelector('#planner-location-gate').hidden && document.querySelector('#planner-location-gate .workflow-locked-message').textContent==='Find a SNAP-authorized store first to unlock grocery planning.'"),'Fresh guest sees the locked Step 2 state');
  check(await evaluate("document.querySelector('#planner-tab').classList.contains('is-workflow-locked') && document.querySelector('#planner-tab').getAttribute('aria-label').includes('locked')"),'Locked planner remains visible and accessible in navigation');
  await layout('#planner-view','planner-locked');
  lockedCardMetrics.planner=await evaluate("(()=>{const c=document.querySelector('#planner-location-gate'),r=c.getBoundingClientRect(),b=c.querySelector('.workflow-lock-badge').getBoundingClientRect(),s=getComputedStyle(c);return {width:r.width,height:r.height,badge:b.width,padding:s.padding,borderRadius:s.borderRadius}})()");
  await evaluate("window.originalLocationGetter=NutriCartLocation.get;NutriCartLocation.get=()=>({});document.dispatchEvent(new Event('nutricart:location-changing'))");
  check(await evaluate("document.querySelector('#planner-form').hidden"),'Empty location object cannot unlock planner');
  await evaluate("NutriCartLocation.get=window.originalLocationGetter");
  await click('#settings-button');
  check(await evaluate("document.querySelectorAll('.settings-category').length===4 && !document.querySelector('canvas.nutricart-food-canvas')"),'Four categories and no cursor particles');
  await click('.settings-category:nth-child(1) summary');
  await evaluate("document.querySelector('[data-setting=textSize]').value='large';document.querySelector('[data-setting=textSize]').dispatchEvent(new Event('change',{bubbles:true}))");
  await click('.settings-category:nth-child(1) summary');await click('.settings-category:nth-child(1) summary');
  check(await evaluate("NutriCartSettings.getSetting('textSize')==='large'"),'Accordion toggling preserves in-session values');
  await click('[data-setting=highContrast]');
  check(await evaluate("document.documentElement.dataset.highContrast==='true'"),'High contrast works');
  await layout('#settings-dialog','settings-accessibility');
  await click('[data-setting=highContrast]');
  await click('.settings-category:nth-child(3) summary');
  await evaluate("document.querySelector('[data-setting=snapRadius]').value='10';document.querySelector('[data-setting=snapRadius]').dispatchEvent(new Event('change',{bubbles:true}))");
  check(await evaluate("document.querySelector('#selected-radius').textContent.includes('10')"),'Search distance preference updates supported radius');
  await click('.settings-category:nth-child(4) summary');
  check(await evaluate("document.querySelector('#clear-saved-settings').hidden && !localStorage.getItem('nutricart.settings.v2')"),'No storage when remembering is disabled');
  await click('[data-setting=rememberSettings]');
  check(await evaluate("Object.keys(JSON.parse(localStorage.getItem('nutricart.settings.v2'))).sort().join(',')==='highContrast,rememberSettings,snapRadius,textSize,usePlannerBudget'"),'Only five approved preference keys are stored');
  await cdp('Page.reload',{ignoreCache:true});await until(()=>evaluate("document.readyState==='complete' && Boolean(window.NutriCartSettings)"),'scripts after preferences reload');
  check(await evaluate("NutriCartSettings.getSetting('snapRadius')===10 && !document.querySelector('#home').hidden"),'Preferences persist and reload always starts Home');
  await evaluate("localStorage.setItem('nutricart.settings.v2',JSON.stringify({rememberSettings:true,textSize:'small',startingView:'budget',cursorEffects:true,confirmBeforeClear:false,snapRadius:25,privateUnknown:'must-disappear'}))");
  await cdp('Page.reload',{ignoreCache:true});await until(()=>evaluate("document.readyState==='complete' && Boolean(window.NutriCartSettings)"),'scripts after preferences reload');
  check(await evaluate("!document.querySelector('#home').hidden && NutriCartSettings.getSetting('textSize')==='normal' && NutriCartSettings.getSetting('confirmBeforeClear')===true && !JSON.parse(localStorage.getItem('nutricart.settings.v2')).privateUnknown"),'Legacy keys ignored and removed; safe defaults restored');
  await click('#settings-button');await click('.settings-category:nth-child(4) summary');
  let dialogAnswer=false,dialogSeen=0;
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Page.javascriptDialogOpening'){dialogSeen++;cdp('Page.handleJavaScriptDialog',{accept:dialogAnswer}).catch(()=>{});}});
  await click('#clear-saved-settings');check(await evaluate("!!localStorage.getItem('nutricart.settings.v2')"),'Cancel preserves saved preferences');
  dialogAnswer=true;await click('#clear-saved-settings');
  check(await evaluate("!localStorage.getItem('nutricart.settings.v2') && document.querySelector('#clear-saved-settings').hidden"),'Confirmed clear removes preferences only');
  await click('#settings-close');
  await evaluate("NutriCartSettings.setSetting('snapRadius',5)");
  await cdp('Page.reload',{ignoreCache:true});await until(()=>evaluate("document.readyState==='complete' && Boolean(window.NutriCartSettings)"),'scripts after preferences reload');
  check(await evaluate("NutriCartSettings.getSetting('snapRadius')===5 && !NutriCartSettings.getSetting('rememberSettings')"),'Disabled persistence does not survive reload');
  await evaluate("document.addEventListener('nutricart:plan-updated',e=>window.task16Plan={context:e.detail.context,result:e.detail.result})");
  await click('#meal-plan-tab');
  check(await evaluate("!document.querySelector('#meal-plan-empty').hidden && document.querySelector('#meal-empty-title').textContent==='Meal Plan' && document.querySelector('#meal-plan-empty .workflow-locked-message').textContent==='Create your grocery basket first to unlock meal ideas.' && document.querySelector('#create-plan-from-meals').textContent==='Find SNAP Stores'"),'Locked Step 3 explains the earliest required action');
  await layout('#meal-plan-view','meal-empty');
  lockedCardMetrics.meal=await evaluate("(()=>{const c=document.querySelector('#meal-plan-empty'),r=c.getBoundingClientRect(),b=c.querySelector('.workflow-lock-badge').getBoundingClientRect(),s=getComputedStyle(c);return {width:r.width,height:r.height,badge:b.width,padding:s.padding,borderRadius:s.borderRadius}})()");
  await click('#shopping-budget-tab');
  check(await evaluate("!document.querySelector('#shopping-budget-locked').hidden && document.querySelector('#budget-dashboard').hidden && document.querySelector('#budget-locked-action').textContent==='Find SNAP Stores'"),'Locked Step 4 replaces the empty dashboard with the earliest action');
  await layout('#shopping-budget-view','budget-locked');
  lockedCardMetrics.budget=await evaluate("(()=>{const c=document.querySelector('#shopping-budget-locked'),r=c.getBoundingClientRect(),b=c.querySelector('.workflow-lock-badge').getBoundingClientRect(),s=getComputedStyle(c);return {width:r.width,height:r.height,badge:b.width,padding:s.padding,borderRadius:s.borderRadius}})()");
  const lockedCards=Object.values(lockedCardMetrics);
  check(lockedCards.every(card=>Math.abs(card.width-lockedCards[0].width)<1&&Math.abs(card.height-lockedCards[0].height)<1&&card.badge===64&&card.padding===lockedCards[0].padding&&card.borderRadius===lockedCards[0].borderRadius),'All three desktop locked cards share dimensions, spacing, radius, and lock badge size');
  await click('#home-button');await click('#hero-find-snap');
  check(await evaluate("!document.querySelector('.locator').hidden"),'Start opens SNAP');
  check(await evaluate("document.querySelector('#detected-location').hidden && !document.querySelector('#snap-build-basket') && document.querySelector('.or').getClientRects().length>0"),'Initial SNAP state has no success panel, empty bar or continuation');
  // Deterministic USDA-response fixtures cover cardinalities; the real endpoints are exercised next.
  await evaluate(`window.realFetch=window.fetch;window.fixtureCount=0;window.fixtureGeocodeFail=false;window.fetch=(url,opts)=>{
    if(url==='/api/geocode' && window.fixtureGeocodeFail)return Promise.resolve(new Response(JSON.stringify({error:'Address could not be found.'}),{status:400}));
    if(url==='/api/geocode')return Promise.resolve(new Response(JSON.stringify({latitude:61.2181,longitude:-149.9003,matched_address:'Public test fixture',planning_location:{locality:'Anchorage',region:'AK'}}),{status:200}));
    if(url==='/api/snap-retailers')return Promise.resolve(new Response(JSON.stringify({retailers:Array.from({length:window.fixtureCount},(_,i)=>({record_id:'fixture-'+i,store_name:'Fixture store '+(i+1),city:'Anchorage',state:'AK',street_address:'Test street',distance_miles:i+1}))}),{status:200}));
    return window.realFetch(url,opts);
  }`);
  for(const count of [0,1,2]) {
    await evaluate(`window.fixtureCount=${count}`);await fill({address:'Public test fixture'});await click('#address-button');
    check(await evaluate(`document.querySelectorAll('[name=snap_store]').length===${count} && !document.querySelector('#snap-build-basket') && !NutriCartStore.get()`),'Fixture '+count+' results require explicit choice');
    if(count) {await click('[name=snap_store]');check(await evaluate("!!NutriCartStore.get() && !!document.querySelector('#snap-build-basket')"),'Fixture '+count+' selection enables continuation');}
  }
  check(await evaluate("!document.querySelector('#detected-location').hidden && document.querySelector('#snap-planning-location').textContent==='Anchorage, AK'"),'Manual address shows actual resolved location confirmation');
  await evaluate('window.fixtureGeocodeFail=true');await fill({address:'Invalid test address'});await click('#address-button');
  check(await evaluate("document.querySelector('#detected-location').hidden && !NutriCartStore.get() && !document.querySelector('#snap-build-basket') && document.querySelector('#status').textContent.includes('could not')"),'Failed geocoding clears success and selected retailer');
  await evaluate('window.fixtureGeocodeFail=false');await fill({address:'Public test fixture'});await click('#address-button');await click('[name=snap_store]');
  await click('.radius-options > summary');await click('[data-radius="10"]');
  check(await evaluate("!NutriCartStore.get() && !document.querySelector('#snap-build-basket')"),'Radius search clears selected store');
  await click('[data-radius="5"]');await click('.radius-options > summary');
  await click('[name=snap_store]');await click('#planner-tab');await click('#snap-tab');
  check(await evaluate("!!NutriCartStore.get() && document.querySelector('[name=snap_store]').checked"),'Navigating back retains the chosen store');
  await click('#new-location');check(await evaluate("!NutriCartStore.get() && !NutriCartLocation.get()"),'New location clears selection and planning location');
  check(await evaluate("document.querySelector('#detected-location').hidden && !document.querySelector('#snap-build-basket')"),'New Location hides confirmation and removes planning button');
  await cdp('Browser.setPermission',{permission:{name:'geolocation'},setting:'denied',origin:url});
  await click('#location-button');
  check(await evaluate("document.querySelector('#detected-location').hidden && document.querySelector('#status').textContent.length>0 && !document.querySelector('#location-button').disabled"),'Denied geolocation shows a usable error without success');
  await cdp('Browser.grantPermissions',{origin:url,permissions:['geolocation']});
  await cdp('Emulation.setGeolocationOverride',{latitude:61.2181,longitude:-149.9003,accuracy:50});
  await evaluate(`window.cardinalityFetch=window.fetch;window.fetch=(url,opts)=>url==='/api/reverse-geocode'?Promise.resolve(new Response(JSON.stringify({matched_address:null,planning_location:null}),{status:200})):window.cardinalityFetch(url,opts)`);
  await click('#location-button');
  check(await evaluate("document.querySelector('#detected-location').hidden && !NutriCartLocation.get() && document.querySelector('#status').textContent.includes('could not be resolved')"),'Unresolved device locality stays gated with visible address instruction');
  await evaluate('window.fetch=window.realFetch');
  await cdp('Browser.grantPermissions',{origin:url,permissions:['geolocation']});
  await cdp('Emulation.setGeolocationOverride',{latitude:61.2181,longitude:-149.9003,accuracy:50});
  await click('#location-button');
  await until(()=>evaluate("!document.querySelector('#location-button').disabled && !!NutriCartLocation.get() && document.querySelectorAll('[name=snap_store]').length>0"),'current location with real SNAP response',90000);
  check(await evaluate("!document.querySelector('#detected-location').hidden && document.querySelector('#snap-planning-location').textContent.length>0"),'Device location shows resolved confirmation using real reverse lookup');
  // Use the real address endpoint and store lookup. This is a public test address.
  await fill({address:'142 W Fifth Ave, Anchorage, AK 99501'});await click('#address-button');
  await until(()=>evaluate("document.querySelectorAll('[name=snap_store]').length>0 && !document.querySelector('#address-button').disabled"),'real SNAP results',90000);
  check(await evaluate("document.querySelectorAll('.store-card').length>1 && document.querySelectorAll('.store-card').length===document.querySelectorAll('[name=snap_store]').length"),'Real USDA results each have a radio control');
  check(await evaluate("!document.querySelector('#snap-build-basket') && !NutriCartStore.get() && !document.querySelector('#snap-plan-transition')"),'No planning button or bottom panel before store selection');
  await click('#planner-tab');check(await evaluate("document.querySelector('#planner-form').hidden && !document.querySelector('#planner-location-gate').hidden && NutriCartWorkflow.get().locationReady && !NutriCartWorkflow.get().storeReady"),'Location alone keeps planner locked until a store is selected');await click('#snap-tab');
  await click('.store-card p');
  check(await evaluate("document.querySelector('.store-card').contains(document.querySelector('#snap-build-basket')) && document.querySelectorAll('#snap-build-basket').length===1 && document.querySelector('[name=snap_store]').checked"),'Clicking card details selects it and places one button inside');
  check(await evaluate("!document.querySelector('#planner-tab').classList.contains('is-workflow-locked') && NutriCartWorkflow.get().locationReady && NutriCartWorkflow.get().storeReady"),'Store selection unlocks Step 2 before navigation');
  if(await evaluate("!document.querySelector('#show-more').hidden")) {
    await evaluate("window.chosenBeforeMore=NutriCartStore.get();document.querySelector('#show-more').scrollIntoView({block:'center',behavior:'instant'})");await delay(200);
    const beforeMore=await evaluate('window.scrollY');
    await evaluate("document.querySelector('#show-more').click()");await delay(300);
    check(await evaluate("JSON.stringify(NutriCartStore.get())===JSON.stringify(window.chosenBeforeMore) && document.querySelector('.store-card.is-selected').contains(document.querySelector('#snap-build-basket'))"),'Show More preserves selection and in-card action');
    check(Math.abs(await evaluate('window.scrollY')-beforeMore)<3,'Show More preserves scroll position');
  }
  while(await evaluate("!document.querySelector('#show-more').hidden")) await click('#show-more');
  await evaluate("document.querySelector('[name=snap_store]').focus()");
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  check(await evaluate("document.querySelectorAll('[name=snap_store]')[1].checked && document.querySelectorAll('.store-card.is-selected').length===1 && document.querySelectorAll('.store-card')[1].contains(document.querySelector('#snap-build-basket')) && !document.querySelector('.store-card').querySelector('button')"),'Keyboard selection moves the single action to the new card');
  const actualDom=await evaluate("(()=>{const cards=[...document.querySelectorAll('.store-card')],button=document.querySelector('#snap-build-basket');return {cardCount:cards.length,buttonCount:document.querySelectorAll('#snap-build-basket').length,inSelectedCard:document.querySelector('.store-card.is-selected').contains(button),bottomPanel:!!document.querySelector('#snap-plan-transition'),radiosVisible:[...document.querySelectorAll('[name=snap_store]')].every(n=>n.getBoundingClientRect().width>0)}})()");
  check(actualDom.inSelectedCard && !actualDom.bottomPanel && actualDom.radiosVisible && actualDom.buttonCount===1,'Live DOM contains one action only inside the selected retailer');
  await writeFile(path.join(artifacts,'localhost-store-dom.json'),JSON.stringify({url,...actualDom},null,2));
  check(await evaluate("document.querySelector('#results-title').textContent==='Select a nearby SNAP-authorized retailer' && !document.querySelector('.locator img[src*=usda]') && document.querySelector('.snap-source-attribution').textContent.includes('Store inventory and prices are not verified.')"),'New selection instruction and factual USDA attribution without logo');
  for(const width of [1440,390,320]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<=390});
    await evaluate("document.querySelector('.store-card.is-selected').scrollIntoView({block:'center',behavior:'instant'})");await delay(250);
    check(await evaluate("(()=>{const a=document.querySelector('.store-card.is-selected').getBoundingClientRect(),b=document.querySelector('#snap-build-basket').getBoundingClientRect();return b.left>=a.left && b.right<=a.right && b.top>=a.top && b.bottom<=a.bottom})()"),'Build button fits inside selected card at '+width);
    const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(artifacts,'selected-store-'+width+'.png'),Buffer.from(shot.data,'base64'));
  }
  await layout('.locator','store-results');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:true});
  await evaluate("document.querySelector('[name=snap_store]').scrollIntoView({block:'center',behavior:'instant'})");await delay(200);
  const storeTouch=await evaluate("(()=>{const r=document.querySelector('[name=snap_store]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[storeTouch]});await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(200);
  check(await evaluate("document.querySelector('[name=snap_store]').checked"),'Mobile touch changes the selected store');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await click('#snap-build-basket');
  check(await evaluate("document.querySelector('#planner-location-gate').hidden && !document.querySelector('#change-planning-location').hidden && !document.querySelector('#planner-form').hidden"),'Valid location reveals form and subtle change action');
  check(await evaluate("document.querySelector('#meal-plan-tab').classList.contains('is-workflow-locked') && document.querySelector('#shopping-budget-tab').classList.contains('is-workflow-locked')"),'Steps 3 and 4 remain locked before basket generation');
  await layout('#planner-view','planner-before');
  check(await evaluate("document.querySelector('#planner-essentials').getClientRects().length>0 && !document.querySelector('#planner-form').hidden"),'Planner heading and form visible before generation');
  await fill({budget:'100',people:'2',days:'7',calories:'2000',protein:'50'});await click('input[name=diet][value=omnivore]');
  check(await evaluate("!document.querySelector('#planner-error').textContent"),'Valid People and Days show no validation');
  for(const [field,value,message] of [
    ['people','0','NutriCart supports plans for 1–20 people.'],
    ['people','21','NutriCart supports plans for 1–20 people.'],
    ['people','2.5','NutriCart supports plans for 1–20 people.'],
    ['days','0','NutriCart supports plans for 1–31 days.'],
    ['days','32','NutriCart supports plans for 1–31 days.'],
    ['days','7.5','NutriCart supports plans for 1–31 days.'],
  ]) {
    await fill({people:'2',days:'7',[field]:value});await click('#review-settings');
    check(await evaluate(`document.querySelector('#planner-error').textContent===${JSON.stringify(message)}`),field+' '+value+' shows friendly validation');
    await fill({[field]:field==='people'?'2':'7'});
    check(await evaluate("!document.querySelector('#planner-error').textContent"),field+' correction clears validation');
  }
  await fill({people:'0',days:'0'});await click('#review-settings');
  check(await evaluate("document.querySelector('#planner-error').textContent==='NutriCart supports plans for 1–20 people and 1–31 days.'"),'Both invalid fields show combined validation');
  await fill({people:'2',days:'7'});
  check(await evaluate("!document.querySelector('#planner-error').textContent"),'Correcting both fields clears combined validation');
  async function generate(diet,budget){
    await fill({budget:String(budget),people:'3',days:'1',calories:'2000',protein:'50'});
    await click(`input[name=diet][value=${diet}]`);
    await until(()=>evaluate("!document.querySelector('#review-plan').disabled"),'review enabled',60000);
    await click('#review-plan');await click('#generate-plan');
    await until(()=>evaluate("!document.querySelector('#plan-results').hidden && document.querySelector('#grocery-plan-loader').hidden"),'real basket',120000);
    check(await evaluate("NutriCartWorkflow.get().basketReady && !document.querySelector('#meal-plan-tab').classList.contains('is-workflow-locked') && !document.querySelector('#shopping-budget-tab').classList.contains('is-workflow-locked')"),diet+': basket unlocks Meal Plan and Shopping Budget independently');
    check(await evaluate("document.querySelector('#plan-results-title').textContent==='Your Grocery Basket' && document.querySelector('#planner-essentials').getClientRects().length===0 && !document.querySelector('#basket-location')"),diet+': one result heading/location');
    const basketContext=await evaluate("(()=>{const context=window.task16Plan.context,summary=document.querySelector('#receipt-context').textContent,store=context.selected_store?.name?.trim()||'',location=[context.location?.locality,context.location?.region].filter(Boolean).join(', ');return {summary,store,location}})()");
    check(basketContext.store && basketContext.summary.startsWith(basketContext.store+' · ') && basketContext.summary.includes(diet.charAt(0).toUpperCase()+diet.slice(1)) && basketContext.summary.includes('3 people') && basketContext.summary.includes('1 day') && (!basketContext.location || !basketContext.summary.includes(basketContext.location)),diet+': basket summary uses the selected retailer without locality '+JSON.stringify(basketContext));
  }
  // Same real resolved location and nutrition settings for both diets.
  await generate('vegan',500.45);check(await evaluate("window.task16Plan.result.groceries.every(p=>p.product_id.startsWith('demo-')) && document.querySelector('#grocery-list').textContent.length>0"),'Independent demo products only');check(await evaluate("document.querySelector('#receipt-price-source').textContent.includes('Example grocery prices')"),'Synthetic price disclosure');await layout('#planner-view','vegan-basket');
  await click('#edit-plan');check(await evaluate("!document.querySelector('#planner-form').hidden && document.querySelector('#budget').value==='500.45'"),'Edit retains original form inputs');
  await click('#snap-tab');
  const changedStore=await evaluate("(()=>{const before=NutriCartStore.get()?.name;const next=[...document.querySelectorAll('[name=snap_store]')].find(radio=>!radio.checked);next.click();return {before,after:NutriCartStore.get()?.name,basketReady:NutriCartWorkflow.get().basketReady}})()");
  check(changedStore.before && changedStore.after && changedStore.before!==changedStore.after && !changedStore.basketReady,'Selecting a different store clears the stale basket '+JSON.stringify(changedStore));
  await click('#snap-build-basket');
  await generate('vegetarian',500.45);
  await click('#snap-tab');
  await evaluate("window.fetch=(url,opts)=>{if(url==='/api/geocode')return Promise.resolve(new Response(JSON.stringify({latitude:47.61,longitude:-122.33,matched_address:'Task 38 public fixture',planning_location:{locality:'Longview',region:'WA'}}),{status:200}));if(url==='/api/snap-retailers')return Promise.resolve(new Response(JSON.stringify({retailers:[{record_id:'task38-short',store_name:'Task 38 Market',city:'Longview',state:'WA',street_address:'Public fixture street',distance_miles:1},{record_id:'task38-long',store_name:'Northwest Community Market and Grocery Cooperative',city:'Longview',state:'WA',street_address:'Public fixture avenue',distance_miles:2}]}),{status:200}));return window.realFetch(url,opts)}");
  await fill({address:'Task 38 public fixture'});await click('#address-button');
  await until(()=>evaluate("document.querySelectorAll('[name=snap_store]').length===2 && !document.querySelector('#address-button').disabled"),'Task 38 retailer fixtures');
  await click('[name=snap_store][value="1"]');
  check(await evaluate("NutriCartStore.get()?.name==='Northwest Community Market and Grocery Cooperative' && !NutriCartWorkflow.get().basketReady"),'New location uses the newly selected long retailer and clears the stale basket');
  await click('#snap-build-basket');
  await evaluate('window.fetch=window.realFetch');
  await click('input[name=diet][value=pescatarian]');await click('#include-fish');
  await generate('pescatarian',25);
  await layout('#planner-view','long-store-basket');
  check(await evaluate("window.task16Plan.context.include_fish && window.task16Plan.result.groceries.some(p=>p.product_id==='demo-salmon')"),'Requested fish included in genuine Pescatarian basket');
  await click('#edit-plan');check(await evaluate("document.querySelector('#include-fish').checked"),'Edit preserves explicit fish preference');
  await generate('pescatarian',25);
  await click('#meal-plan-tab');
  check(await evaluate("!document.querySelector('#meal-plan-ready').hidden && document.querySelector('#meal-plan-results').hidden && document.querySelector('.meal-plan-subtitle').textContent==='Turn your grocery basket into simple meal ideas.' && document.querySelector('#meal-plan-ready p').textContent==='Use the groceries already in your basket to build your meal plan.'"),'Unlocked Meal Plan shows the connected empty state');
  await layout('#meal-plan-view','meal-ready');
  const mealReadyMetrics=await evaluate("(()=>{const c=document.querySelector('#meal-plan-ready').getBoundingClientRect(),b=document.querySelector('#create-meal-plan').getBoundingClientRect();document.querySelector('#create-meal-plan').focus();return {width:c.width,height:c.height,buttonHeight:b.height,focused:document.activeElement.id}})()");
  check(mealReadyMetrics.width<=801 && mealReadyMetrics.height<330 && mealReadyMetrics.buttonHeight>=52 && mealReadyMetrics.focused==='create-meal-plan','Unlocked Meal Plan card is compact and keyboard ready '+JSON.stringify(mealReadyMetrics));
  await click('#planner-tab');
  await click('#alternative-plan');await until(()=>evaluate("document.querySelector('#grocery-plan-loader').hidden && !document.querySelector('#alternative-plan').disabled"),'alternative complete',120000);
  check(await evaluate("!document.querySelector('#plan-results').hidden && document.querySelector('#plan-results-title').textContent==='Your Grocery Basket' && document.querySelector('#planner-essentials').getClientRects().length===0"),'Alternative keeps single result heading');
  await click('#open-meal-from-plan');await until(()=>evaluate("!document.querySelector('#meal-plan-results').hidden"),'real meals',60000);
  check(await evaluate("!document.querySelector('#meal-source-summary').textContent.includes(window.task16Plan.context.location.locality) && !!window.task16Plan.context.selected_store"),'Meal summary omits locality while plan retains store context');
  const generatedMealQuality=await evaluate(`(()=>{const days=[...document.querySelectorAll('.meal-day-card')].map(day=>{const meals=[...day.querySelectorAll('.meal-card')].map(card=>({type:card.querySelector('.meal-type').textContent.toLowerCase(),title:card.querySelector('h4').textContent}));return {meals,lunch:meals.find(meal=>meal.type==='lunch')?.title||'',dinner:meals.find(meal=>meal.type==='dinner')?.title||''}});const titles=days.flatMap(day=>day.meals.map(meal=>meal.title));const mainTitles=days.flatMap(day=>[day.lunch,day.dinner]).filter(Boolean);return {titles,distinctSameDay:days.every(day=>!day.lunch||!day.dinner||day.lunch!==day.dinner),hasCatalogQualifier:titles.some(title=>/(?:,|\\b)(?:raw|dry|uncooked|long-grain|prepared from)\\b/i.test(title)),mealLikeMainTitles:mainTitles.every(title=>/Bowl|Soup| with /i.test(title)),fishTitles:titles.filter(title=>/salmon|tuna|fish/i.test(title)).length}})()`);
  check(!generatedMealQuality.hasCatalogQualifier,'Generated meal titles omit raw catalog descriptors '+JSON.stringify(generatedMealQuality.titles));
  check(generatedMealQuality.distinctSameDay,'Generated lunch and dinner titles differ when basket options exist');
  check(generatedMealQuality.mealLikeMainTitles,'Generated lunch and dinner use concise meal-style titles');
  check(generatedMealQuality.fishTitles>0 && generatedMealQuality.fishTitles<generatedMealQuality.titles.length,'Pescatarian meals use available fish without putting fish in every meal');
  await layout('#meal-plan-view','generated-meals');
  check(await evaluate("[...document.querySelectorAll('#meal-plan-view h1')].filter(h=>h.getClientRects().length).length===1 && document.querySelector('#meal-open-budget').textContent==='Track My Shopping'"),'Generated meals retain explicit shopping action');
  await click('#meal-open-budget');
  await layout('#shopping-budget-view','shopping');
  for(const width of [1440,390,320]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<=390});await delay(200);
    check(await evaluate(`(()=>{const b=document.querySelector('#budget-balance-card').getBoundingClientRect(),l=document.querySelector('#shopping-list-panel').getBoundingClientRect();return ${width}>850 ? Math.abs(b.top-l.top)<2 && l.left>b.right : l.top>=b.bottom && l.top-b.bottom<25})()`),'Budget/list adjacency at '+width);
    await evaluate("document.querySelector('#shopping-budget-view').scrollIntoView({block:'start',behavior:'instant'})");await delay(200);
    const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(artifacts,'shopping-top-'+width+'.png'),Buffer.from(shot.data,'base64'));
  }
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  check(await evaluate("[...document.querySelectorAll('.shopping-list-quantity')].every(n=>n.textContent.includes('\\u00b7') && !n.textContent.includes(' ? '))"),'Shopping separator renders correctly');
  check(await evaluate("!document.querySelector('#additional-purchases').open && document.querySelector('#shopping-list-title').textContent==='Your Shopping List'"),'List is primary; manual purchases collapsed below');
  const state=async()=>{const value=await evaluate("new Promise(resolve=>{document.addEventListener('nutricart:budget-state',e=>resolve(e.detail),{once:true});document.dispatchEvent(new Event('nutricart:request-budget-state'))})");await evaluate("if(!document.querySelector('#save-dialog').hidden) document.querySelector('#save-cancel').click()");return value;};
  const before=await state();check(before.purchases.length===0,'Displaying a basket does not spend');
  await click('[data-shopping-check]');const estimated=await state();
  check(estimated.purchases.length===1 && estimated.purchases[0].estimated && estimated.purchases[0].costCents===estimated.shoppingItems[0].estimatedCents,'Mark purchased deducts the basket line estimate once');
  await evaluate("document.dispatchEvent(new CustomEvent('nutricart:plan-updated',{detail:{...window.task16Plan,plannedItems:window.task16Plan.result.groceries}}))");
  check((await state()).purchases.length===1 && await evaluate("document.querySelector('[data-shopping-check]').checked"),'Rerender preserves linked purchase without duplicates');
  await click('[data-shopping-add-price]');
  await evaluate("const f=document.querySelector('[data-edit-purchase-form]');f.elements.cost.value='4.25'");
  await click('[data-edit-purchase-form] button[type=submit]');const edited=await state();
  check(edited.purchases[0].costCents===425 && !edited.purchases[0].estimated,'Edited checkout price replaces estimate');
  dialogAnswer=false;await click('[data-shopping-check]');
  check((await state()).purchases.length===1,'Cancel undo preserves edited purchase');
  dialogAnswer=true;await click('[data-shopping-check]');check((await state()).purchases.length===0,'Confirmed uncheck reverses edited purchase');
  await click('[data-shopping-check]');await click('[data-shopping-check]');check((await state()).purchases.length===0,'Unedited estimate reverses directly');
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:true});
  await evaluate("document.querySelector('[data-shopping-check]').scrollIntoView({behavior:'instant',block:'center'})");await delay(200);
  const touch=await evaluate("(()=>{const r=document.querySelector('[data-shopping-check]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch]});await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(300);
  check((await state()).purchases.length===1,'Mobile touch marks purchased');
  await click('#select-all-shopping');const all=await state();
  check(all.purchases.length===all.shoppingItems.length,'Confirmed mark all counts each listed item once');
  await click('#additional-purchases > summary');await fill({'purchase-item':'Regression groceries','purchase-cost':'3.50'});await click('#add-purchase');const bought=await state();
  check(bought.purchases.length===all.purchases.length+1 && bought.purchases.at(-1).costCents===350,'Manual extra purchase recorded independently');
  const storedBeforeClear=await evaluate("document.querySelector('#purchase-log').textContent");
  dialogAnswer=false;await click('#clear-purchases');
  check(await evaluate("document.querySelector('#purchase-log').textContent")===storedBeforeClear,'Clearing purchases asks and cancel preserves them');
  await click('#planner-tab');
  // Capture the same payload consumed by the existing save/restore UI.
  const saved=await evaluate("window.task16Plan");
  assert(saved.context && saved.result.groceries.length);
  await evaluate(`document.dispatchEvent(new CustomEvent('nutricart:open-saved-plan',{detail:{data:${JSON.stringify(saved)},updated_at:'2026-10-02T12:00:00Z'}}))`);await delay(600);
  check(await evaluate("!document.querySelector('#plan-results').hidden && document.querySelector('#planner-essentials').getClientRects().length===0"),'Saved basket restore uses same compact result');
  check(await evaluate("document.querySelector('#receipt-context').textContent.startsWith(window.task16Plan.context.selected_store.name+' · ') && !document.querySelector('#receipt-context').textContent.includes([window.task16Plan.context.location?.locality,window.task16Plan.context.location?.region].filter(Boolean).join(', '))"),'Saved basket restores its selected retailer summary');
  await click('#shopping-budget-tab');const restored=await state();
  check(JSON.stringify(restored.purchases)===JSON.stringify(bought.purchases),'Restoring basket preserves purchases');
  check(await evaluate("fetch('/api/account/session').then(r=>r.json()).then(r=>!r.authenticated)"),'Guest session works');
  check(await evaluate("fetch('/api/saved-items').then(r=>r.status===503)"),'Cloud save explicitly unavailable');
  await evaluate(`document.dispatchEvent(new CustomEvent('nutricart:open-saved-shopping',{detail:{id:'test-session',data:${JSON.stringify(restored)}}}))`);await delay(600);
  check(JSON.stringify((await state()).purchases)===JSON.stringify(restored.purchases),'Saved shopping restoration preserves exact purchase ledger');
  check(await evaluate("[...document.querySelectorAll('[data-shopping-check]')].every(n=>n.checked)"),'Restored purchase links keep list checked');
  await click('#meal-plan-tab');await click('#shopping-budget-tab');
  check(JSON.stringify((await state()).purchases)===JSON.stringify(restored.purchases),'Returning tabs retains restored shopping session');
  const persisted=restored;
  const remaining=await evaluate("document.querySelector('#budget-remaining').textContent");
  check(remaining.includes(((persisted.startingBudgetCents-persisted.purchases.reduce((sum,p)=>sum+p.costCents,0))/100).toFixed(2)),'Displayed remaining balance matches purchase arithmetic');
  await click('#planner-tab');await click('#edit-plan');
  await generate('vegan',10);await delay(300);
  check(await evaluate("document.querySelector('#plan-results-title').getBoundingClientRect().top>=document.querySelector('.site-header').getBoundingClientRect().bottom"),'Mobile generated basket heading stays below sticky navigation');
  const screenshot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(artifacts,'mobile-generated-basket.png'),Buffer.from(screenshot.data,'base64'));
  await click('#footer-home');check(await evaluate("!document.querySelector('#home').hidden"),'Footer logo and wordmark return Home');
  await click('#home-button');check(await evaluate("!document.querySelector('#home').hidden"),'Header logo returns Home');
  await click('#planner-tab');await click('#edit-plan');await click('#change-planning-location');
  check(await evaluate("!document.querySelector('.locator').hidden"),'Change location returns to existing SNAP tool');
  await click('#new-location');await click('#planner-tab');
  check(await evaluate("document.querySelector('#planner-form').hidden && !document.querySelector('#planner-location-gate').hidden && !NutriCartWorkflow.get().basketReady && document.querySelector('#meal-plan-tab').classList.contains('is-workflow-locked') && document.querySelector('#shopping-budget-tab').classList.contains('is-workflow-locked')"),'Clearing location invalidates the old basket and relocks dependent steps without losing purchases');
  await click('#settings-button');
  for(let index=0;index<4;index++) {
    await evaluate(`(()=>{const category=document.querySelectorAll('.settings-category')[${index}];category.open=false;category.querySelector('summary').focus()})()`);
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    check(await evaluate(`document.querySelectorAll('.settings-category')[${index}].open`),'Settings category '+(index+1)+' opens from keyboard');
  }
  await layout('#settings-dialog','all-settings-open');
  await click('#settings-close');
  await evaluate(`(()=>{const tray=document.createElement('div');tray.id='logo-review';tray.style='position:fixed;inset:200px 10px auto 10px;z-index:99999;background:#fff9ed;padding:20px;display:flex;align-items:center;gap:16px';for(const size of [16,32,48,128]){const svg=document.querySelector('#home-button svg').cloneNode(true);svg.style.width=size+'px';svg.style.height=size+'px';svg.style.flex='none';tray.append(svg);}document.body.append(tray)})()`);
  const logos=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(artifacts,'logo-sizes.png'),Buffer.from(logos.data,'base64'));
  check(await evaluate("[...document.querySelectorAll('#logo-review svg')].map(s=>s.getBoundingClientRect().width).join(',')==='16,32,48,128'"),'SVG rendered at 16, 32, 48 and 128 pixels');
  await evaluate("document.querySelector('#logo-review').remove()");
  if (!externalUrl) {
    const stopped=once(server,'exit');server.kill();await Promise.race([stopped,delay(5000)]);
    server=spawn(pythonPath,["-B","-m","flask","--app","app","run","--host","127.0.0.1","--port",String(port),"--no-reload"],{
      cwd:root,windowsHide:true,
      env:{...process.env,NUTRICART_CATALOG_MODE:"demo",NUTRICART_DATABASE:path.join(runtime,"accounts.db"),FLASK_DEBUG:"0",PYTHONDONTWRITEBYTECODE:"1",PYTHON_DOTENV_DISABLED:"1",FLASK_SKIP_DOTENV:"1",NUTRICART_FEEDBACK_TO:""},
      stdio:["ignore","pipe","pipe"],
    });
    server.stdout.on("data",chunk=>{serverOutput+=chunk;});server.stderr.on("data",chunk=>{serverOutput+=chunk;});
    await until(async()=>{try{return (await localGet(url)).status===200;}catch{return false;}},"account-enabled Flask readiness");
    await cdp('Page.navigate',{url});await until(()=>evaluate("document.readyState==='complete' && Boolean(window.NutriCartSettings)"),'account-enabled scripts');
    check(await evaluate("document.querySelector('#account-auth-panel').dataset.accountsEnabled==='true' && document.querySelector('#sign-in-form') && document.querySelector('#create-account-form') && document.querySelector('#forgot-password-form') && !document.querySelector('#demo-account-panel') && [...document.querySelectorAll('#save-grocery-plan,#save-meal-plan,#save-shopping-list')].every(n=>!n.hidden)"),'Non-Vercel mode preserves authentication and saving controls');
    for(const [width,size] of [[1440,'normal'],[390,'extra-large'],[320,'extra-large']]) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<=390});
      await evaluate(`NutriCartSettings.setSetting('textSize',${JSON.stringify(size)})`);await delay(100);await click('#account-button');
      const accountState=await evaluate("(()=>{const d=document.querySelector('#account-dialog'),r=d.getBoundingClientRect();return {visible:!d.hidden,focus:document.activeElement.id,bounds:[r.left,r.right,innerWidth],scroll:[d.scrollWidth,d.clientWidth]}})()");
      check(accountState.visible && accountState.focus==='account-close' && accountState.bounds[0]>=0 && accountState.bounds[1]<=accountState.bounds[2] && accountState.scroll[0]<=accountState.scroll[1]+1,'Account form fits '+width+' '+size+' '+JSON.stringify(accountState));
      await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      check(await evaluate("document.querySelector('#account-dialog').hidden && document.activeElement.id==='account-button'"),'Account form Escape restores focus '+width);
    }
  }
  check(assets.length>0 && assets.every(a=>a.status===200),'All static assets load');
  await writeFile(path.join(artifacts,'results.json'),JSON.stringify({checks,layouts,browserErrors},null,2));
  check(browserErrors.length===0,'Zero console errors');
  console.log('CHECKS',checks.length,'LAYOUTS',layouts.length);
} catch (error) {
  await writeFile(path.join(artifacts, "failure.txt"), String(error.stack || error));
  await writeFile(path.join(artifacts, "server.log"), serverOutput);
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await cdp("Browser.close").catch(() => {});
    socket.close();
  }
  for (const child of [edge, server]) {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await Promise.race([exited, delay(5000)]);
    }
  }
}
