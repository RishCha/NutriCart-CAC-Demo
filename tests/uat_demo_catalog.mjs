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
      PYTHON_DOTENV_DISABLED: "1", FLASK_SKIP_DOTENV: "1", NUTRICART_FEEDBACK_TO: "", SUPABASE_URL: "", SUPABASE_ANON_KEY: ""},
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
  await evaluate("history.pushState({task73:true},'',location.pathname+'?task73-history=1');history.back()");
  await until(()=>evaluate("location.search===''"),'browser back navigation');
  check(await evaluate("document.readyState==='complete' && Boolean(window.NutriCartWorkflow) && !document.querySelector('#home').hidden"),'Browser Back preserves the loaded Home state');
  await evaluate("history.forward()");await until(()=>evaluate("location.search==='?task73-history=1'"),'browser forward navigation');
  check(await evaluate("Boolean(window.NutriCartWorkflow) && !document.querySelector('#home').hidden"),'Browser Forward preserves the loaded Home state');
  await evaluate("history.replaceState(null,'',location.pathname)");
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
  await evaluate("NutriCartSettings.setSetting('cursorEffects',false);document.addEventListener('nutricart:plan-updated',e=>window.currentPlan={context:e.detail.context,result:e.detail.result})");
  check(await evaluate("document.querySelectorAll('.hero-actions button').length===1 && document.querySelector('#hero-find-snap').textContent===\"Let's get started\""),'Home unchanged');
  check(await evaluate("(()=>{const logos=[document.querySelector('#home-button svg'),document.querySelector('.footer-brand svg')];return logos.every(logo=>logo&&logo.querySelector('#shopping-cart-symbol .cart-handle')&&logo.querySelector('.cart-basket')&&logo.querySelector('.cart-slats')&&logo.querySelectorAll('.cart-wheel').length===2)&&document.querySelector('link[rel=icon]').href.includes('shopping-cart-symbol')})()"),'Transparent shopping-cart logo is shared by header footer and favicon');
  for(const [width,size] of [[1440,'normal'],[390,'extra-large'],[320,'extra-large']]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<=390});
    await evaluate(`NutriCartSettings.setSetting('textSize',${JSON.stringify(size)})`);await delay(100);
    const iconState=await evaluate("(()=>{const button=document.querySelector('#settings-button'),icon=button.querySelector('svg.settings-icon'),b=button.getBoundingClientRect(),i=icon.getBoundingClientRect();return {button:[b.width,b.height],icon:[i.width,i.height],center:[Math.abs((b.left+b.width/2)-(i.left+i.width/2)),Math.abs((b.top+b.height/2)-(i.top+i.height/2))],aria:button.getAttribute('aria-label'),title:button.title,hidden:icon.getAttribute('aria-hidden'),focusable:icon.getAttribute('focusable'),stroke:icon.getAttribute('stroke'),overflow:document.documentElement.scrollWidth>innerWidth+1}})()");
    check(iconState.button[0]===44 && iconState.button[1]>=42 && iconState.icon[0]===20 && iconState.icon[1]===20 && iconState.center.every(delta=>delta<0.6) && iconState.aria==='Settings' && iconState.title==='Settings' && iconState.hidden==='true' && iconState.focusable==='false' && iconState.stroke==='currentColor' && !iconState.overflow,'Settings SVG stays centered and accessible '+width+' '+size+' '+JSON.stringify(iconState));
  }
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await evaluate("NutriCartSettings.setSetting('textSize','normal');document.querySelector('#settings-button').focus()");
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await delay(150);
  check(await evaluate("!document.querySelector('#settings-dialog').hidden"),'Settings SVG button opens with Enter');
  await click('#settings-close');await evaluate("document.querySelector('#settings-button').focus()");
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});await delay(150);
  check(await evaluate("!document.querySelector('#settings-dialog').hidden"),'Settings SVG button opens with Space');
  await click('#settings-close');
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
  check(await evaluate("document.querySelector('#feedback-title').textContent==='How was your NutriCart experience?' && document.querySelector('#feedback-support').textContent==='Your feedback helps make NutriCart better.' && document.querySelector('#feedback-form').hidden && document.querySelectorAll('#feedback-rating button').length===2 && !document.querySelector('#feedback-note') && !document.querySelector('#feedback-privacy')"),'Feedback stage one is balanced and concise');
  await click('[data-rating=positive]');
  check(await evaluate("document.querySelector('#feedback-title').textContent==='What did you like about NutriCart?' && document.querySelector('#feedback-support').textContent==='We value your feedback.' && document.querySelector('#feedback-submit').disabled && document.querySelector('#feedback-skip').disabled"),'Positive follow-up is optional and unconfigured delivery stays disabled');
  await click('#feedback-back');await evaluate("document.querySelector('[data-rating=negative]').focus()");
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});

  check(await evaluate("document.querySelector('#feedback-title').textContent==='What could we improve?' && document.querySelector('#feedback-support').textContent==='We value your feedback.'"),'Negative question is conditional');
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
  // Controlled transport fixtures never send email. Backend Resend tests separately verify provider acknowledgement over HTTPS.
  await evaluate(`window.feedbackRealFetch=window.fetch;window.feedbackPosts=[];window.feedbackFixture={status:502,body:{error:'We could not confirm delivery. Please try again later.'}};window.fetch=(url,opts)=>{
    if(url==='/api/feedback') {
      if(opts?.method==='POST') {window.feedbackPosts.push(JSON.parse(opts.body));const fixture=window.feedbackFixture;const responseBody=Object.hasOwn(fixture,'raw')?fixture.raw:JSON.stringify(fixture.body);return new Promise(resolve=>setTimeout(()=>resolve(new Response(responseBody,{status:fixture.status,headers:{'Content-Type':'application/json'}})),300));}
      return Promise.resolve(new Response(JSON.stringify({enabled:true,csrf_token:'test-token'}),{status:200}));
    }
    return window.feedbackRealFetch(url,opts);
  }`);
  await click('#feedback-desktop');await click('[data-rating=positive]');
  check(await evaluate("document.querySelector('#feedback-submit').disabled && !document.querySelector('#feedback-skip').disabled"),'Empty comment uses Skip while Submit remains disabled');
  await fill({'feedback-comment':'   '});
  check(await evaluate("document.querySelector('#feedback-submit').disabled"),'Whitespace does not enable Submit Feedback');
  await fill({'feedback-comment':'Useful tools'});
  check(await evaluate("!document.querySelector('#feedback-submit').disabled"),'Written feedback enables Submit Feedback');
  await fill({'feedback-comment':''});
  check(await evaluate("document.querySelector('#feedback-submit').disabled"),'Clearing feedback disables Submit Feedback again');
  await click('#feedback-back');
  check(await evaluate("window.feedbackPosts.length===0 && document.querySelector('#feedback-title').textContent==='How was your NutriCart experience?' && document.querySelector('#feedback-form').hidden"),'Back returns without submitting');
  await click('[data-rating=positive]');await fill({'feedback-comment':'Useful tools'});
  await evaluate("document.querySelector('#feedback-form').requestSubmit();document.querySelector('#feedback-form').requestSubmit()");await delay(500);
  check(await evaluate("window.feedbackPosts.length===1 && document.querySelector('#feedback-thanks').hidden && document.querySelector('#feedback-comment').value==='Useful tools' && document.querySelector('#feedback-title').textContent==='What did you like about NutriCart?' && document.querySelector('#feedback-status').textContent==='We could not confirm delivery. Please try again later.'"),'Duplicate submit blocked; failed delivery retains rating and draft');

  await evaluate("window.feedbackFixture={status:400,body:{error:{message:'Nested feedback message.'}}}");await click('#feedback-submit');await delay(400);
  check(await evaluate("window.feedbackPosts.length===2 && document.querySelector('#feedback-status').textContent==='Nested feedback message.' && !document.querySelector('#feedback-status').textContent.includes('[object Object]') && document.querySelector('#feedback-comment').value==='Useful tools'"),'Nested non-429 error object is normalized and preserves the draft');

  await evaluate("window.feedbackFixture={status:400,body:{message:'Plain message response.'}}");await click('#feedback-submit');await delay(400);
  check(await evaluate("window.feedbackPosts.length===3 && document.querySelector('#feedback-status').textContent==='Plain message response.' && document.querySelector('#feedback-comment').value==='Useful tools'"),'Message response is readable and preserves the draft');

  await evaluate("window.feedbackFixture={status:400,body:'Plain string response.'}");await click('#feedback-submit');await delay(400);
  check(await evaluate("window.feedbackPosts.length===4 && document.querySelector('#feedback-status').textContent==='Plain string response.' && document.querySelector('#feedback-comment').value==='Useful tools'"),'Plain string response is readable');

  await evaluate("window.feedbackFixture={status:502,raw:'not-json'}");await click('#feedback-submit');await delay(400);
  check(await evaluate("window.feedbackPosts.length===5 && document.querySelector('#feedback-status').textContent==='We could not confirm delivery. Please try again later.' && !document.querySelector('#feedback-status').textContent.includes('[object Object]') && document.querySelector('#feedback-comment').value==='Useful tools' && document.querySelector('#feedback-thanks').hidden"),'Malformed response uses generic fallback and preserves state');

  await evaluate("window.feedbackFixture={status:200,body:{delivered:true}}");await click('#feedback-submit');await delay(400);
  check(await evaluate("window.feedbackPosts.length===6 && !document.querySelector('#feedback-thanks').hidden && document.querySelector('#feedback-cooldown').hidden && document.querySelector('#feedback-title').textContent==='Thank you for helping us improve NutriCart!' && document.querySelector('#feedback-support').textContent==='Your feedback has been submitted.' && document.querySelector('#feedback-form').hidden && Number(sessionStorage.getItem('nutricart:feedback-cooldown-until'))>Date.now()+55000 && document.activeElement.id==='feedback-title'"),'Acknowledged delivery shows success and stores a sixty-second client cooldown');
  check(await evaluate("window.feedbackPosts.every(p=>Object.keys(p).sort().join(',')==='comment,rating') && document.querySelector('#feedback-comment').value===''"),'Feedback sends no shopping metadata and clears delivered comment');
  await click('#feedback-done');
  check(await evaluate("!document.querySelector('#feedback-dialog').open && document.activeElement.id==='feedback-desktop'"),'Done closes success and restores focus');
  await click('#feedback-desktop');await delay(100);
  check(await evaluate("window.feedbackPosts.length===6 && document.querySelector('#feedback-dialog').open && document.querySelector('#feedback-title').textContent==='Please wait a minute before sending another feedback response.' && document.querySelector('#feedback-support').textContent==='You can send more feedback shortly.' && document.querySelector('#feedback-rating').hidden && document.querySelector('#feedback-form').hidden && document.querySelector('#feedback-thanks').hidden && !document.querySelector('#feedback-cooldown').hidden && document.activeElement.id==='feedback-title'"),'Reopening during client cooldown immediately shows only the accessible cooldown view without a POST');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  check(await evaluate("(()=>{const d=document.querySelector('#feedback-dialog').getBoundingClientRect(),b=document.querySelector('#feedback-cooldown-done').getBoundingClientRect();return d.left>=0&&d.right<=innerWidth&&b.width>250&&document.documentElement.scrollWidth<=innerWidth;})()"),'Cooldown view fits mobile with a clear full-width Done action');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await click('#feedback-cooldown-done');
  check(await evaluate("!document.querySelector('#feedback-dialog').open && document.activeElement.id==='feedback-desktop'"),'Cooldown Done closes and restores focus');

  await evaluate("window.feedbackRealNow=Date.now;Date.now=()=>window.feedbackRealNow()+61000");await click('#feedback-desktop');await delay(100);
  check(await evaluate("document.querySelector('#feedback-title').textContent==='How was your NutriCart experience?' && !document.querySelector('#feedback-rating').hidden && document.querySelector('#feedback-cooldown').hidden && sessionStorage.getItem('nutricart:feedback-cooldown-until')===null"),'Expired client cooldown restores normal feedback on reopen without a reload');
  await evaluate("Date.now=window.feedbackRealNow;delete window.feedbackRealNow");

  await click('[data-rating=positive]');await fill({'feedback-comment':'Server cooldown test'});await evaluate("window.feedbackFixture={status:429,body:{error:'Backend detail should not be shown'}}");await click('#feedback-submit');await delay(400);
  check(await evaluate("window.feedbackPosts.length===7 && document.querySelector('#feedback-title').textContent==='Please wait a minute before sending another feedback response.' && !document.querySelector('#feedback-title').textContent.includes('Backend detail') && document.querySelector('#feedback-rating').hidden && document.querySelector('#feedback-form').hidden && document.querySelector('#feedback-thanks').hidden && !document.querySelector('#feedback-cooldown').hidden && Number(sessionStorage.getItem('nutricart:feedback-cooldown-until'))>Date.now()+55000"),'Server JSON 429 activates the local cooldown view and ignores provider text');
  await click('#feedback-cooldown-done');

  await evaluate("sessionStorage.removeItem('nutricart:feedback-cooldown-until');window.feedbackRealNow=Date.now;Date.now=()=>window.feedbackRealNow()+61000");await click('#feedback-desktop');await delay(100);await evaluate("Date.now=window.feedbackRealNow;delete window.feedbackRealNow");await click('[data-rating=positive]');await fill({'feedback-comment':'Firewall cooldown test'});await evaluate("window.feedbackFixture={status:429,raw:'Too Many Requests'}");await click('#feedback-submit');await delay(400);
  check(await evaluate("window.feedbackPosts.length===8 && document.querySelector('#feedback-title').textContent==='Please wait a minute before sending another feedback response.' && !document.body.textContent.includes('Too Many Requests') && !document.body.textContent.includes('[object Object]') && document.querySelector('#feedback-rating').hidden && document.querySelector('#feedback-form').hidden && document.querySelector('#feedback-thanks').hidden && !document.querySelector('#feedback-cooldown').hidden"),'Clearing client state cannot bypass a server 429 and raw firewall wording stays hidden');
  await click('#feedback-cooldown-done');

  await evaluate("sessionStorage.removeItem('nutricart:feedback-cooldown-until');window.feedbackRealNow=Date.now;Date.now=()=>window.feedbackRealNow()+61000;window.feedbackFixture={status:200,body:{delivered:true}}");await click('#feedback-desktop');await delay(100);await evaluate("Date.now=window.feedbackRealNow;delete window.feedbackRealNow");await click('[data-rating=negative]');await fill({'feedback-comment':'This text must not be sent by Skip'});await click('#feedback-skip');await delay(400);
  check(await evaluate("window.feedbackPosts.length===9 && window.feedbackPosts[8].rating==='negative' && window.feedbackPosts[8].comment==='' && !document.querySelector('#feedback-thanks').hidden"),'Skip still submits the selected rating with no comment');
  await click('#feedback-done');await evaluate("sessionStorage.removeItem('nutricart:feedback-cooldown-until');window.fetch=window.feedbackRealFetch");
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
  await evaluate("document.addEventListener('nutricart:plan-updated',e=>window.currentPlan={context:e.detail.context,result:e.detail.result})");
  await click('#meal-plan-tab');
  check(await evaluate("!document.querySelector('#meal-plan-empty').hidden && document.querySelector('#meal-empty-title').textContent==='Meal Plan' && document.querySelector('#meal-plan-empty .workflow-locked-message').textContent==='Create your grocery basket first to unlock meal ideas.' && document.querySelector('#create-plan-from-meals').textContent==='Find SNAP Stores'"),'Locked Step 4 explains the earliest required action');
  await layout('#meal-plan-view','meal-empty');
  lockedCardMetrics.meal=await evaluate("(()=>{const c=document.querySelector('#meal-plan-empty'),r=c.getBoundingClientRect(),b=c.querySelector('.workflow-lock-badge').getBoundingClientRect(),s=getComputedStyle(c);return {width:r.width,height:r.height,badge:b.width,padding:s.padding,borderRadius:s.borderRadius}})()");
  await click('#shopping-budget-tab');
  check(await evaluate("!document.querySelector('#shopping-budget-locked').hidden && document.querySelector('#budget-dashboard').hidden && document.querySelector('#budget-locked-action').textContent==='Find SNAP Stores'"),'Locked Step 3 replaces the empty dashboard with the earliest action');
  await layout('#shopping-budget-view','budget-locked');
  lockedCardMetrics.budget=await evaluate("(()=>{const c=document.querySelector('#shopping-budget-locked'),r=c.getBoundingClientRect(),b=c.querySelector('.workflow-lock-badge').getBoundingClientRect(),s=getComputedStyle(c);return {width:r.width,height:r.height,badge:b.width,padding:s.padding,borderRadius:s.borderRadius}})()");
  const lockedCards=Object.values(lockedCardMetrics);
  check(lockedCards.every(card=>Math.abs(card.width-lockedCards[0].width)<1&&Math.abs(card.height-lockedCards[0].height)<1&&card.badge===64&&card.padding===lockedCards[0].padding&&card.borderRadius===lockedCards[0].borderRadius),'All three desktop locked cards share dimensions, spacing, radius, and lock badge size');
  await click('#home-button');await click('#hero-find-snap');
  check(await evaluate("!document.querySelector('.locator').hidden"),'Start opens SNAP');
  check(await evaluate("document.querySelector('#detected-location').hidden && !document.querySelector('#snap-build-basket') && document.querySelector('.or').getClientRects().length>0"),'Initial SNAP state has no success panel, empty bar or continuation');
  // Deterministic USDA-response fixtures cover cardinalities; the real endpoints are exercised next.
  await evaluate(`window.realFetch=window.fetch;window.fixtureCount=0;window.fixtureNames=[];window.fixtureGeocodeFail=false;window.fetch=(url,opts)=>{
    if(url==='/api/geocode' && window.fixtureGeocodeFail)return Promise.resolve(new Response(JSON.stringify({error:'Address could not be found.'}),{status:400}));
    if(url==='/api/geocode')return Promise.resolve(new Response(JSON.stringify({latitude:61.2181,longitude:-149.9003,matched_address:'Public test fixture',planning_location:{locality:'Anchorage',region:'AK'}}),{status:200}));
    if(url==='/api/snap-retailers')return Promise.resolve(new Response(JSON.stringify({retailers:Array.from({length:window.fixtureCount},(_,i)=>({record_id:'fixture-'+i,store_name:window.fixtureNames[i]||'Fixture store '+(i+1),city:'Anchorage',state:'AK',street_address:'Test street '+(i+1),distance_miles:i+1}))}),{status:200}));
    return window.realFetch(url,opts);
  }`);
  for(const count of [0,1,2]) {
    await evaluate(`window.fixtureCount=${count}`);await fill({address:'Public test fixture'});await click('#address-button');
    check(await evaluate(`document.querySelectorAll('[name=snap_store]').length===${count} && !document.querySelector('#snap-build-basket') && !NutriCartStore.get()`),'Fixture '+count+' results require explicit choice');
    if(count) {await click('[name=snap_store]');check(await evaluate("!!NutriCartStore.get() && !!document.querySelector('#snap-build-basket')"),'Fixture '+count+' selection enables continuation');}
  }
  await evaluate("window.fixtureNames=['2701868.0 1868','7-eleven #41347a 41347A','99 Ranch Market','Circle K 1490'];window.fixtureCount=4");await fill({address:'Public test fixture'});await click('#address-button');
  check(await evaluate("JSON.stringify([...document.querySelectorAll('.store-card h3')].map(n=>n.textContent))===JSON.stringify(['SNAP-authorized retailer','7-Eleven','99 Ranch Market','Circle K'])"),'Retailer labels normalize numeric records, repeated identifiers, and terminal store numbers');
  check(await evaluate("document.querySelectorAll('.store-card').length===4 && [...document.querySelectorAll('.store-card')].map(card=>card.textContent.match(/Test street \\d/)?.[0]).filter(Boolean).length===4"),'Duplicate chain locations remain separate and distinguishable by address');
  await click('[name=snap_store][value="1"]');
  check(await evaluate("NutriCartStore.get().name==='7-Eleven' && NutriCartStore.get().source_name==='7-eleven #41347a 41347A'"),'Selected retailer keeps a clean display name and preserved source name');
  await evaluate("window.fixtureNames=[];window.fixtureCount=2");
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
  check(await evaluate("!document.querySelector('#workflow-progress').hidden && document.querySelector('[data-progress-step=snap]').getAttribute('aria-current')==='step' && !document.querySelector('[data-progress-step=planner]').classList.contains('is-complete')"),'Progress identifies Store as the current first step');
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
  check(await evaluate("document.querySelector('[data-progress-step=snap]').classList.contains('is-complete') && document.querySelector('[data-progress-step=planner]').getAttribute('aria-current')==='step'"),'Progress marks Store complete and Plan current');
  check(await evaluate("document.querySelector('#meal-plan-tab').classList.contains('is-workflow-locked') && document.querySelector('#shopping-budget-tab').classList.contains('is-workflow-locked')"),'Steps 3 and 4 remain locked before basket generation');
  await layout('#planner-view','planner-before');
  check(await evaluate("document.querySelector('#planner-essentials').getClientRects().length>0 && !document.querySelector('#planner-form').hidden"),'Planner heading and form visible before generation');
  check(await evaluate("[...document.querySelectorAll('.required-marker')].length===4 && ['budget','people','days'].every(id=>document.querySelector('#'+id).getAttribute('aria-required')==='true') && document.querySelector('#diet-options').getAttribute('aria-required')==='true'"),'Planner exposes four visible and accessible required fields');
  await fill({budget:'',people:'',days:'',calories:'2000',protein:'50'});await click('#review-settings');
  check(await evaluate("document.activeElement.id==='budget' && document.querySelector('#budget-validation').textContent==='Enter your grocery budget.' && document.querySelector('#budget').getAttribute('aria-invalid')==='true'"),'Missing planner values focus and identify the first invalid field');
  await fill({budget:'100',people:'2',days:'7'});await click('input[name=diet][value=omnivore]');
  check(await evaluate("[...document.querySelectorAll('.planner-inline-error')].every(n=>n.hidden && !n.textContent) && !document.querySelector('#planner-error').textContent"),'Correcting required values clears inline validation immediately');
  for(const [field,value,message] of [
    ['people','0','NutriCart supports plans for 1–20 people.'],
    ['people','21','NutriCart supports plans for 1–20 people.'],
    ['people','2.5','NutriCart supports plans for 1–20 people.'],
    ['days','0','NutriCart supports plans for 1–31 days.'],
    ['days','32','NutriCart supports plans for 1–31 days.'],
    ['days','7.5','NutriCart supports plans for 1–31 days.'],
  ]) {
    await fill({people:'2',days:'7',[field]:value});await click('#review-settings');
    check(await evaluate(`document.querySelector('#${field}-validation').textContent===${JSON.stringify(message)} && document.activeElement.id==='${field}'`),field+' '+value+' shows friendly inline validation and receives focus');
    await fill({[field]:field==='people'?'2':'7'});
    check(await evaluate(`document.querySelector('#${field}-validation').hidden && !document.querySelector('#${field}-validation').textContent`),field+' correction clears inline validation');
  }
  await fill({people:'0',days:'0'});await click('#review-settings');
  check(await evaluate("document.activeElement.id==='people' && document.querySelector('#people-validation').textContent==='NutriCart supports plans for 1–20 people.' && document.querySelector('#days-validation').textContent==='NutriCart supports plans for 1–31 days.'"),'Both invalid fields show specific inline validation and focus the first');
  await fill({people:'2',days:'7'});
  check(await evaluate("document.querySelector('#people-validation').hidden && document.querySelector('#days-validation').hidden"),'Correcting both fields clears inline validation');
  await evaluate("document.querySelectorAll('input[name=diet]').forEach(input=>{input.checked=false})");await click('#review-settings');
  check(await evaluate("document.activeElement.name==='diet' && document.querySelector('#diet-validation').textContent==='Choose a dietary preference.'"),'Missing Diet focuses the radio group and shows its inline message');
  await click('input[name=diet][value=omnivore]');
  async function generate(diet,budget,people=3,days=1){
    await fill({budget:String(budget),people:String(people),days:String(days),calories:'2000',protein:'50'});
    await click(`input[name=diet][value=${diet}]`);
    await until(()=>evaluate("!document.querySelector('#review-plan').disabled"),'review enabled',60000);
    await click('#review-plan');await click('#generate-plan');
    await until(()=>evaluate("!document.querySelector('#plan-results').hidden && document.querySelector('#grocery-plan-loader').hidden"),'real basket',120000);
    check(await evaluate("NutriCartWorkflow.get().basketReady && !document.querySelector('#meal-plan-tab').classList.contains('is-workflow-locked') && !document.querySelector('#shopping-budget-tab').classList.contains('is-workflow-locked')"),diet+': basket unlocks Meal Plan and Shopping Budget independently');
    check(await evaluate("document.querySelector('#plan-results-title').textContent==='Your Grocery Basket' && document.querySelector('#planner-essentials').getClientRects().length===0 && !document.querySelector('#basket-location')"),diet+': one result heading/location');
    const basketContext=await evaluate("(()=>{const context=window.currentPlan.context,summary=document.querySelector('#receipt-context').textContent,store=context.selected_store?.name?.trim()||'',location=[context.location?.locality,context.location?.region].filter(Boolean).join(', ');return {summary,store,location}})()");
    check(basketContext.store && basketContext.summary.startsWith(basketContext.store+' · ') && basketContext.summary.includes(diet.charAt(0).toUpperCase()+diet.slice(1)) && basketContext.summary.includes(people+' '+(people===1?'person':'people')) && basketContext.summary.includes(days+' '+(days===1?'day':'days')) && (!basketContext.location || !basketContext.summary.includes(basketContext.location)),diet+': basket summary uses the selected retailer without locality '+JSON.stringify(basketContext));
  }
  // Same real resolved location and nutrition settings for both diets.
  await generate('vegan',500.45);check(await evaluate("window.currentPlan.result.groceries.every(p=>p.product_id.startsWith('demo-')) && document.querySelector('#grocery-list').textContent.length>0"),'Independent demo products only');check(await evaluate("document.querySelector('#receipt-price-source').textContent.includes('Example grocery prices') && document.querySelector('.basket-availability-note').textContent==='Basket items are planning suggestions. Prices and product availability vary by retailer and location.'"),'Synthetic price and product availability disclosure');await layout('#planner-view','vegan-basket');
  await click('#edit-plan');check(await evaluate("!document.querySelector('#planner-form').hidden && document.querySelector('#budget').value==='500.45'"),'Edit retains original form inputs');
  await click('#snap-tab');
  const changedStore=await evaluate("(()=>{const before=NutriCartStore.get()?.name;const next=[...document.querySelectorAll('[name=snap_store]')].find(radio=>!radio.checked);next.click();return {before,after:NutriCartStore.get()?.name,basketReady:NutriCartWorkflow.get().basketReady}})()");
  check(changedStore.before && changedStore.after && changedStore.before!==changedStore.after && !changedStore.basketReady,'Selecting a different store clears the stale basket '+JSON.stringify(changedStore));
  await click('#snap-build-basket');
  await generate('vegetarian',200,2,10);
  check(await evaluate("(()=>{const items=window.currentPlan.result.groceries,counts=items.reduce((all,item)=>({...all,[item.category]:(all[item.category]||0)+1}),{}),names=items.map(item=>item.product_name);return items.length>=13&&['Fruit','Vegetables','Grains'].every(category=>(counts[category]||0)>=2)&&names.some(name=>/milk|yogurt|egg/i.test(name))&&names.some(name=>/tofu|peanut/i.test(name))})()"),'Exact Vegetarian case has bounded food-group and protein-family diversity');
  await click('#meal-plan-tab');await until(()=>evaluate("!document.querySelector('#meal-plan-ready').hidden"),'exact vegetarian direct Meal Plan unlock');
  check(await evaluate("NutriCartWorkflow.get().basketReady && document.querySelector('#meal-plan-empty').hidden && !document.querySelector('#meal-plan-ready').hidden"),'$200 / 2 people / 10 days Vegetarian basket unlocks Meal Plan directly');
  await click('#planner-tab');
  await click('#snap-tab');
  await evaluate("window.fetch=(url,opts)=>{if(url==='/api/geocode')return Promise.resolve(new Response(JSON.stringify({latitude:47.61,longitude:-122.33,matched_address:'Public retailer fixture',planning_location:{locality:'Longview',region:'WA'}}),{status:200}));if(url==='/api/snap-retailers')return Promise.resolve(new Response(JSON.stringify({retailers:[{record_id:'fixture-short',store_name:'Fixture Market',city:'Longview',state:'WA',street_address:'Public fixture street',distance_miles:1},{record_id:'fixture-long',store_name:'Northwest Community Market and Grocery Cooperative',city:'Longview',state:'WA',street_address:'Public fixture avenue',distance_miles:2}]}),{status:200}));return window.realFetch(url,opts)}");
  await fill({address:'Public retailer fixture'});await click('#address-button');
  await until(()=>evaluate("document.querySelectorAll('[name=snap_store]').length===2 && !document.querySelector('#address-button').disabled"),'retailer fixtures');
  await click('[name=snap_store][value="1"]');
  check(await evaluate("NutriCartStore.get()?.name==='Northwest Community Market and Grocery Cooperative' && !NutriCartWorkflow.get().basketReady"),'New location uses the newly selected long retailer and clears the stale basket');
  await click('#snap-build-basket');
  await evaluate('window.fetch=window.realFetch');
  await click('input[name=diet][value=pescatarian]');await click('#include-fish');
  await generate('pescatarian',25);
  await layout('#planner-view','long-store-basket');
  check(await evaluate("window.currentPlan.context.include_fish && window.currentPlan.result.groceries.some(p=>p.product_id==='demo-salmon')"),'Requested fish included in genuine Pescatarian basket');
  await click('#edit-plan');check(await evaluate("document.querySelector('#include-fish').checked"),'Edit preserves explicit fish preference');
  await generate('pescatarian',25);
  await click('#meal-plan-tab');
  check(await evaluate(`!document.querySelector('#meal-plan-ready').hidden && document.querySelector('#meal-plan-results').hidden && document.querySelector('.meal-plan-subtitle').textContent==="Your groceries are ready. Let's plan some meals." && document.querySelector('#meal-ready-copy').textContent==="Use the foods already in your basket."`),'Unlocked Meal Plan shows the connected empty state');
  await layout('#meal-plan-view','meal-ready');
  const mealReadyMetrics=await evaluate("(()=>{const c=document.querySelector('#meal-plan-ready').getBoundingClientRect(),b=document.querySelector('#create-meal-plan').getBoundingClientRect();document.querySelector('#create-meal-plan').focus();return {width:c.width,height:c.height,buttonHeight:b.height,focused:document.activeElement.id}})()");
  check(mealReadyMetrics.width<=761 && mealReadyMetrics.height<330 && mealReadyMetrics.buttonHeight>=52 && mealReadyMetrics.focused==='create-meal-plan','Unlocked Meal Plan card is compact and keyboard ready '+JSON.stringify(mealReadyMetrics));
  await click('#planner-tab');
  await click('#alternative-plan');await until(()=>evaluate("document.querySelector('#grocery-plan-loader').hidden && !document.querySelector('#alternative-plan').disabled"),'alternative complete',120000);
  check(await evaluate("!document.querySelector('#plan-results').hidden && document.querySelector('#plan-results-title').textContent==='Your Grocery Basket' && document.querySelector('#planner-essentials').getClientRects().length===0"),'Alternative keeps single result heading');
  check(await evaluate("document.querySelector('#start-shopping-from-plan').textContent==='Continue to Shopping Budget' && document.querySelector('#next-actions-title').textContent==='Your grocery plan is ready.'"),'Grocery Plan points to Shopping Budget');
  await click('#start-shopping-from-plan');await until(()=>evaluate("!document.querySelector('#budget-dashboard').hidden"),'shopping budget');
  check(await evaluate("document.querySelector('#budget-view-title').previousElementSibling.textContent==='Step 3 of 4' && document.querySelector('#budget-open-meal').textContent==='Continue to Meal Plan'"),'Shopping Budget is Step 3 and points to Meal Plan');
  check(await evaluate("document.querySelector('[data-progress-step=snap]').classList.contains('is-complete') && document.querySelector('[data-progress-step=planner]').classList.contains('is-complete') && document.querySelector('[data-progress-step=budget]').getAttribute('aria-current')==='step'"),'Progress marks Store and Plan complete with Shop current');
  await click('#select-all-shopping');
  check(await evaluate("!document.querySelector('#shopping-completion').hidden && document.querySelector('.budget-next-step').hidden && document.querySelector('#shopping-completion-title').textContent==='All done shopping?' && document.querySelector('#shopping-complete-open-meal').textContent==='Continue to Meal Plan'"),'All planned checklist items reveal one completion path');
  for(const width of [390,320]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await delay(100);
    const flowLayout=await evaluate("(()=>{const progress=document.querySelector('#workflow-progress'),panel=document.querySelector('#shopping-completion'),button=document.querySelector('#shopping-complete-open-meal'),pr=progress.getBoundingClientRect(),r=panel.getBoundingClientRect(),b=button.getBoundingClientRect();return {progressFits:pr.left>=0&&pr.right<=innerWidth+1,labelsFit:[...progress.querySelectorAll('li>span:last-child')].every(label=>label.scrollWidth<=label.clientWidth+1),panelFits:r.left>=0&&r.right<=innerWidth+1,buttonFits:b.left>=r.left&&b.right<=r.right,overflow:document.documentElement.scrollWidth>innerWidth+1}})()");
    check(flowLayout.progressFits&&flowLayout.labelsFit&&flowLayout.panelFits&&flowLayout.buttonFits&&!flowLayout.overflow,'Progress and completion panel fit at '+width+' '+JSON.stringify(flowLayout));
  }
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await click('[data-shopping-check]');
  check(await evaluate("document.querySelector('#shopping-completion').hidden && !document.querySelector('.budget-next-step').hidden"),'Unchecking one planned item restores the normal Meal Plan path');
  await click('[data-shopping-check]');
  await click('#shopping-complete-open-meal');await until(()=>evaluate("!document.querySelector('#meal-plan-ready').hidden"),'meal ready');
  check(await evaluate("document.querySelector('[data-progress-step=budget]').classList.contains('is-complete') && document.querySelector('[data-progress-step=meal]').getAttribute('aria-current')==='step'"),'Progress marks Shop complete and Meals current');
  await click('#create-meal-plan');await until(()=>evaluate("!document.querySelector('#meal-plan-results').hidden"),'real meals',60000);
  check(await evaluate("!document.querySelector('#meal-source-summary').textContent.includes(window.currentPlan.context.location.locality) && !!window.currentPlan.context.selected_store"),'Meal summary omits locality while plan retains store context');
  const longMealPlan=await evaluate(`(async()=>{const plan=window.currentPlan,context={...plan.context,days:10};const response=await fetch('/api/meal-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groceries:plan.result.groceries.map(item=>({product_id:String(item.product_id),quantity:item.quantity})),people:context.people,days:context.days,diet:context.diet,food_group_exclusions:context.food_group_exclusions||[],foods_to_avoid:context.foods_to_avoid||[],nutrition_focus:context.nutrition_focus||'none',targets:context.targets||{}})});const data=await response.json();data.recipe_directions_ai_assisted=true;data.days[0].meals[0].directions=['Legacy saved direction'];window.generatedMealPlan=data;document.dispatchEvent(new CustomEvent('nutricart:open-saved-meal',{detail:{data:{mealPlan:data,groceries:plan.result.groceries,context}}}));return {status:response.status,days:data.days?.length||0,meals:data.days?.flatMap(day=>day.meals||[]).length||0}})()`);
  check(longMealPlan.status===200 && longMealPlan.days===7 && longMealPlan.meals>7,'Seven-day meal plan renders through the live endpoint '+JSON.stringify(longMealPlan));
  await until(()=>evaluate("document.querySelectorAll('.meal-day-card').length===7"),'seven rendered meal days');
  const generatedMealQuality=await evaluate(`(()=>{const days=[...document.querySelectorAll('.meal-day-card')].map(day=>{const meals=[...day.querySelectorAll('.meal-card')].map(card=>({type:card.querySelector('.meal-type').textContent.toLowerCase(),title:card.querySelector('h4').textContent}));return {meals,lunch:meals.find(meal=>meal.type==='lunch')?.title||'',dinner:meals.find(meal=>meal.type==='dinner')?.title||''}});const titles=days.flatMap(day=>day.meals.map(meal=>meal.title));const mainTitles=days.flatMap(day=>[day.lunch,day.dinner]).filter(Boolean);return {titles,distinctSameDay:days.every(day=>!day.lunch||!day.dinner||day.lunch!==day.dinner),hasCatalogQualifier:titles.some(title=>/(?:,|\\b)(?:raw|dry|uncooked|long-grain|prepared from)\\b/i.test(title)),mealLikeMainTitles:mainTitles.every(title=>/Bowl|Soup|Skillet|Plate| with /i.test(title)),fishTitles:titles.filter(title=>/salmon|tuna|fish/i.test(title)).length}})()`);
  check(!generatedMealQuality.hasCatalogQualifier,'Generated meal titles omit raw catalog descriptors '+JSON.stringify(generatedMealQuality.titles));
  check(generatedMealQuality.distinctSameDay,'Generated lunch and dinner titles differ when basket options exist');
  check(generatedMealQuality.mealLikeMainTitles,'Generated lunch and dinner use concise meal-style titles');
  check(generatedMealQuality.fishTitles>0 && generatedMealQuality.fishTitles<generatedMealQuality.titles.length,'Pescatarian meals use available fish without putting fish in every meal');
  const renderedMealCards=await evaluate("(()=>{const cards=[...document.querySelectorAll('.meal-card')];return {cards:cards.length,basketFoods:cards.filter(card=>card.querySelector('.meal-product-details summary')?.textContent==='Basket foods').length,directions:document.querySelectorAll('.meal-directions').length,howTo:cards.filter(card=>card.textContent.includes('How to make it')).length,aiNote:Boolean(document.querySelector('#meal-ai-note'))}})()");
  check(renderedMealCards.cards>0 && renderedMealCards.basketFoods===renderedMealCards.cards && renderedMealCards.directions===0 && renderedMealCards.howTo===0 && !renderedMealCards.aiNote,'Meal cards retain basket provenance without recipe directions '+JSON.stringify(renderedMealCards));
  check(await evaluate("document.querySelector('#meal-basket-nutrition').textContent.includes('Daily reference:') && !document.querySelector('#meal-basket-nutrition').textContent.includes('Target:') && document.querySelector('.basket-nutrition-reference-note').textContent.includes('not personalized nutrition recommendations')"),'Basket Nutrition uses general daily-reference wording');
  check(await evaluate("document.querySelector('#meal-plan-title').textContent==='Your Meal Plan' && document.querySelector('#meal-plan-context').textContent==='10 days · 3 people · Pescatarian' && document.querySelector('#meal-results-title').textContent==='Daily Meals' && document.querySelector('#meal-rotation-note').textContent==='A 7-day meal rotation for your 10-day grocery plan.'"),'Generated Meal Plan presents one connected hierarchy with accurate plan context and rotation');
  await evaluate("document.querySelector('.meal-product-details summary').focus()");
  await cdp('Input.dispatchKeyEvent',{type:'rawKeyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,nativeVirtualKeyCode:32});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32,nativeVirtualKeyCode:32});
  const basketFoodsKeyboard=await evaluate("(()=>({focused:document.activeElement.matches('.meal-product-details summary'),tag:document.activeElement.tagName,open:document.activeElement.parentElement?.open===true,tabIndex:document.activeElement.tabIndex}))()");
  check(basketFoodsKeyboard.focused && basketFoodsKeyboard.tag==='SUMMARY' && basketFoodsKeyboard.open && basketFoodsKeyboard.tabIndex===0,'Basket foods disclosure is keyboard accessible '+JSON.stringify(basketFoodsKeyboard));
  check(await evaluate("document.querySelector('#meal-completion-title').textContent==='Your plan is ready!' && document.querySelector('#meal-plan-another').textContent==='Plan Another Grocery Trip' && document.querySelector('#meal-back-to-basket').textContent==='Back to Grocery Basket'"),'Meal Plan ends with clear completion actions');
  await layout('#meal-plan-view','generated-meals');
  check(await evaluate("[...document.querySelectorAll('#meal-plan-view h1')].filter(h=>h.getClientRects().length).length===1 && document.querySelector('#meal-plan-title').previousElementSibling.textContent==='Step 4 of 4' && document.querySelector('#meal-back-to-budget').textContent==='Back to Shopping Budget'"),'Generated meals are the final workflow step');
  const planBeforeCompletion=await evaluate("JSON.stringify(window.currentPlan)");
  await click('#meal-back-to-basket');await until(()=>evaluate("!document.querySelector('#planner-view').hidden"),'back to current basket');
  check(await evaluate("!document.querySelector('#plan-results').hidden"),'Back to Grocery Basket returns to the current basket');
  await click('#meal-plan-tab');await until(()=>evaluate("!document.querySelector('#meal-plan-results').hidden"),'return to generated meals');
  await click('#meal-plan-another');await until(()=>evaluate("!document.querySelector('#planner-view').hidden && !document.querySelector('#planner-form').hidden"),'plan another grocery trip');
  check(await evaluate(`${JSON.stringify(planBeforeCompletion)}===JSON.stringify(window.currentPlan) && document.querySelector('#plan-results').hidden && !!NutriCartStore.get()`),'Plan Another Grocery Trip opens the preserved planner inputs without resetting plan or retailer state');
  await click('#meal-plan-tab');
  await click('#meal-back-to-budget');
  check(await evaluate("(()=>{const name=window.currentPlan.context.selected_store.name.trim(),label=document.querySelector('#budget-store-context');return !label.hidden && label.textContent==='Selected SNAP retailer: '+name && !label.textContent.includes(window.currentPlan.context.location?.locality||'__no_locality__')})()"),'Shopping Budget labels the selected SNAP retailer without a locality fallback');
  await click('#reset-shopping-checks');
  check(await evaluate("document.querySelector('#shopping-completion').hidden && !document.querySelector('.budget-next-step').hidden"),'Resetting planned purchases clears the completion state');
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
  await evaluate("document.dispatchEvent(new CustomEvent('nutricart:plan-updated',{detail:{...window.currentPlan,plannedItems:window.currentPlan.result.groceries}}))");
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
  await click('#additional-purchases > summary');await fill({'purchase-item':'Regression groceries','purchase-cost':'3.50'});await click('#add-purchase');
  const purchaseConfirmation=await evaluate("(()=>({visible:!document.querySelector('#purchase-success').hidden,text:document.querySelector('#purchase-success').textContent,focus:document.activeElement.id}))()");
  const bought=await state();
  check(bought.purchases.length===all.purchases.length+1 && bought.purchases.at(-1).costCents===350,'Manual extra purchase recorded independently');
  check(purchaseConfirmation.visible && purchaseConfirmation.text==='✓ Item has been added!' && purchaseConfirmation.focus==='purchase-item','Successful manual purchase announces confirmation and preserves entry focus '+JSON.stringify(purchaseConfirmation));
  await fill({'purchase-item':'Next item'});
  check(await evaluate("document.querySelector('#purchase-success').hidden && !document.querySelector('#purchase-success').textContent"),'Beginning another purchase clears the confirmation');
  const storedBeforeClear=await evaluate("document.querySelector('#purchase-log').textContent");
  dialogAnswer=false;await click('#clear-purchases');
  check(await evaluate("document.querySelector('#purchase-log').textContent")===storedBeforeClear,'Clearing purchases asks and cancel preserves them');
  await click('#planner-tab');
  // Capture the same payload consumed by the existing save/restore UI.
  const saved=await evaluate("(()=>{const saved=structuredClone(window.currentPlan);saved.context.selected_store={...saved.context.selected_store,name:'7-eleven #41347a 41347A',source_name:'7-eleven #41347a 41347A'};return saved})()");
  assert(saved.context && saved.result.groceries.length);
  await evaluate(`document.dispatchEvent(new CustomEvent('nutricart:open-saved-plan',{detail:{data:${JSON.stringify(saved)},updated_at:'2026-10-02T12:00:00Z'}}))`);await delay(600);
  check(await evaluate("!document.querySelector('#plan-results').hidden && document.querySelector('#planner-essentials').getClientRects().length===0"),'Saved basket restore uses same compact result');
  check(await evaluate("window.currentPlan.context.selected_store.name==='7-Eleven' && window.currentPlan.context.selected_store.source_name==='7-eleven #41347a 41347A' && document.querySelector('#receipt-context').textContent.startsWith('7-Eleven · ') && !document.querySelector('#receipt-context').textContent.includes([window.currentPlan.context.location?.locality,window.currentPlan.context.location?.region].filter(Boolean).join(', '))"),'Saved basket normalizes its selected retailer summary while preserving the source name');
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
  await evaluate(`(()=>{const tray=document.createElement('div');tray.id='logo-review';tray.style='position:fixed;inset:130px 10px auto 10px;z-index:99999;background:#fff9ed;padding:14px;display:grid;gap:8px';for(const background of ['#fff9ed','#ffffff','#edf5ef']){const row=document.createElement('div');row.dataset.logoBackground=background;row.style='min-height:150px;padding:10px;display:flex;align-items:center;gap:16px;background:'+background;for(const size of [16,32,38,48,128]){const svg=document.querySelector('#home-button svg').cloneNode(true);svg.style.width=size+'px';svg.style.height=size+'px';svg.style.flex='none';row.append(svg);}tray.append(row);}document.body.append(tray)})()`);
  const logos=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(artifacts,'logo-sizes.png'),Buffer.from(logos.data,'base64'));
  check(await evaluate("[...document.querySelectorAll('#logo-review [data-logo-background]')].every(row=>[...row.querySelectorAll('svg')].map(s=>s.getBoundingClientRect().width).join(',')==='16,32,38,48,128')"),'SVG rendered at 16, 32, 38, 48 and 128 pixels on cream, white and pale green');
  await evaluate("document.querySelector('#logo-review').remove()");
  if (!externalUrl) {
    const stopped=once(server,'exit');server.kill();await Promise.race([stopped,delay(5000)]);
    server=spawn(pythonPath,["-B","-m","flask","--app","app","run","--host","127.0.0.1","--port",String(port),"--no-reload"],{
      cwd:root,windowsHide:true,
      env:{...process.env,NUTRICART_CATALOG_MODE:"demo",FLASK_DEBUG:"0",PYTHONDONTWRITEBYTECODE:"1",PYTHON_DOTENV_DISABLED:"1",FLASK_SKIP_DOTENV:"1",NUTRICART_FEEDBACK_TO:"",SUPABASE_URL:"https://project.supabase.co",SUPABASE_ANON_KEY:"publishable-test-key"},
      stdio:["ignore","pipe","pipe"],
    });
    server.stdout.on("data",chunk=>{serverOutput+=chunk;});server.stderr.on("data",chunk=>{serverOutput+=chunk;});
    await until(async()=>{try{return (await localGet(url)).status===200;}catch{return false;}},"account-enabled Flask readiness");
    await cdp('Page.navigate',{url});await until(()=>evaluate("document.readyState==='complete' && Boolean(window.NutriCartSettings)"),'account-enabled scripts');
    check(await evaluate("document.querySelector('#account-auth-panel').dataset.accountsEnabled==='true' && document.querySelector('#sign-in-form') && document.querySelector('#create-account-form') && document.querySelector('#forgot-password-form') && !document.querySelector('#demo-account-panel') && document.querySelector('#resend-confirmation-mode').hidden && [...document.querySelectorAll('#save-grocery-plan,#save-meal-plan,#save-shopping-list')].every(n=>!n.hidden)"),'Configured Supabase mode exposes authentication with contextual confirmation help');
    for(const [width,size] of [[1440,'normal'],[390,'extra-large'],[320,'extra-large']]) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<=390});
      await evaluate(`NutriCartSettings.setSetting('textSize',${JSON.stringify(size)})`);await delay(100);await click('#account-button');
      const accountState=await evaluate("(()=>{const d=document.querySelector('#account-dialog'),c=d.querySelector('.account-drawer-content'),intro=document.querySelector('#sign-in-intro'),r=d.getBoundingClientRect(),cr=c.getBoundingClientRect(),ir=intro.getBoundingClientRect(),padding=parseFloat(getComputedStyle(c).paddingLeft);return {visible:!d.hidden,focus:document.activeElement.id,bounds:[r.left,r.right,innerWidth],scroll:[d.scrollWidth,d.clientWidth],padding,aligned:ir.left>=cr.left+padding-1}})()");
      check(accountState.visible && accountState.focus==='account-close' && accountState.bounds[0]>=0 && accountState.bounds[1]<=accountState.bounds[2] && accountState.scroll[0]<=accountState.scroll[1]+1 && accountState.padding>=16 && accountState.aligned,'Account form fits with padded body '+width+' '+size+' '+JSON.stringify(accountState));
      await evaluate("(()=>{const d=document.querySelector('#account-dialog');d.scrollTop=d.scrollHeight;document.querySelector('#create-account-mode').click()})()");await delay(80);
      const createState=await evaluate("(()=>{const d=document.querySelector('#account-dialog'),h=d.querySelector(':scope > .settings-header'),intro=document.querySelector('#create-account-intro'),input=document.querySelector('#account-password'),hr=h.getBoundingClientRect(),ir=intro.getBoundingClientRect(),background=getComputedStyle(h).backgroundColor;return {scrollTop:d.scrollTop,header:[hr.top,hr.bottom],intro:[ir.top,ir.bottom],background,heading:intro.querySelector('h3').textContent,hint:document.querySelector('#account-password-help').textContent,pattern:input.pattern,overflow:document.documentElement.scrollWidth>innerWidth+1}})()");
      check(createState.scrollTop===0 && createState.intro[0]>=createState.header[1] && createState.background==='rgb(255, 253, 248)' && createState.heading==='Create your NutriCart account' && createState.hint==='Use at least 10 characters and include both letters and numbers. For a stronger password, use a longer phrase with a mix of letters and numbers.' && createState.pattern==='(?=.*[A-Za-z])(?=.*[0-9]).{10,}' && !createState.overflow,'Create Account starts below opaque sticky header '+width+' '+size+' '+JSON.stringify(createState));
      check(await evaluate("(()=>{const input=document.querySelector('#account-password');input.value='letters-only';const lettersOnly=input.checkValidity();input.value='1234567890';const digitsOnly=input.checkValidity();input.value='NutriCart10';const valid=input.checkValidity();input.value='';return !lettersOnly&&!digitsOnly&&valid})()"),'Create Account enforces ten characters with letters and digits '+width+' '+size);
      await evaluate("document.querySelector('#account-close').focus()");
      await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8});
      const trappedAtEnd=await evaluate("document.activeElement.id==='sign-in-mode'");
      await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      check(trappedAtEnd && await evaluate("document.activeElement.id==='account-close'"),'Account form traps keyboard focus '+width);
      await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      check(await evaluate("document.querySelector('#account-dialog').hidden && document.activeElement.id==='account-button'"),'Account form Escape restores focus '+width);
    }
    await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate("NutriCartSettings.setSetting('textSize','normal');window.__accountRealFetch=window.fetch;window.__registrationCalls=0;window.fetch=(input,options={})=>String(input).endsWith('/api/account/register')?(window.__registrationCalls++,Promise.resolve(new Response(JSON.stringify({user:null,confirmation_required:true}),{status:201,headers:{'Content-Type':'application/json'}}))):window.__accountRealFetch(input,options)");
    await click('#account-button');await click('#create-account-mode');
    await evaluate("(()=>{document.querySelector('#account-first-name').value='Sample';document.querySelector('#account-email').value='sample@example.test';document.querySelector('#account-password').value='letters-only';document.querySelector('#account-password-confirm').value='letters-only';document.querySelector('#create-account-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})()");
    check(await evaluate("window.__registrationCalls===0 && document.querySelector('#account-status').textContent==='Use at least 10 characters and include both letters and numbers.'"),'Invalid signup password is stopped before the backend');
    await evaluate("(()=>{document.querySelector('#account-first-name').value='Sample';document.querySelector('#account-email').value='sample@example.test';document.querySelector('#account-password').value='NutriCart10';document.querySelector('#account-password-confirm').value='NutriCart10';document.querySelector('#create-account-form').requestSubmit()})()");
    await until(()=>evaluate("document.querySelector('#account-status').textContent.length>0"),'pending confirmation message');
    check(await evaluate("document.querySelector('#account-status').textContent==='Check your email to confirm your account before signing in.' && !document.querySelector('#sign-in-form').hidden && !document.querySelector('#resend-confirmation-mode').hidden && document.querySelector('#account-user-panel').hidden && window.__registrationCalls===1"),'Pending confirmation stays signed out and shows clear guidance');
    await click('#create-account-mode');
    await evaluate("window.fetch=(input,options={})=>String(input).endsWith('/api/account/register')?(window.__registrationCalls++,Promise.resolve(new Response(JSON.stringify({error:'provider wording'}),{status:429,headers:{'Content-Type':'application/json'}}))):window.__accountRealFetch(input,options);document.querySelector('#account-first-name').value='Sample';document.querySelector('#account-email').value='sample@example.test';document.querySelector('#account-password').value='NutriCart10';document.querySelector('#account-password').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#account-password-confirm').value='NutriCart10';document.querySelector('#account-password-confirm').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#create-account-form').requestSubmit()");
    await until(()=>evaluate("document.querySelector('#account-status').textContent.includes('Too many account attempts')"),'signup rate-limit message');
    await evaluate("document.querySelector('#create-account-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
    check(await evaluate("window.__registrationCalls===2 && document.querySelector('#create-account-submit').disabled && document.querySelector('#account-status').textContent==='Too many account attempts. Please wait a moment before trying again.'"),'Rate-limited signup stays disabled and blocks repeat submissions');
    await evaluate("window.fetch=window.__accountRealFetch;delete window.__accountRealFetch");await click('#account-close');

    await evaluate("window.__accountRealFetch=window.fetch;window.fetch=(input,options={})=>String(input).endsWith('/api/account/login')?Promise.resolve(new Response(JSON.stringify({user:{id:'11111111-1111-4111-8111-111111111111',email:'sample@example.test',first_name:'Sample',last_name:'Shopper',created_at:'now'}}),{status:200,headers:{'Content-Type':'application/json'}})):window.__accountRealFetch(input,options)");
    await click('#account-button');
    await evaluate("(()=>{document.querySelector('#sign-in-email').value='sample@example.test';document.querySelector('#sign-in-password').value='NutriCart10';document.querySelector('#sign-in-form').requestSubmit()})()");
    await until(()=>evaluate("!document.querySelector('#account-user-panel').hidden"),'mocked signed-in account');
    check(await evaluate("document.querySelector('#account-status').textContent==='Signed in. Your saved content is available on this device.' && document.querySelector('#account-status').getAttribute('role')==='status'"),'Successful sign-in is announced once');
    const signedInLayout=await evaluate("(()=>{const c=document.querySelector('.account-drawer-content'),cr=c.getBoundingClientRect(),identity=document.querySelector('.account-welcome').getBoundingClientRect(),tabs=document.querySelector('.account-nav').getBoundingClientRect(),padding=parseFloat(getComputedStyle(c).paddingLeft);document.querySelector('[data-account-section=settings]').click();const settings=document.querySelector('#account-settings-panel').getBoundingClientRect();return {padding,identity:identity.left>=cr.left+padding-1,tabs:tabs.left>=cr.left+padding-1,settings:settings.left>=cr.left+padding-1,status:document.querySelector('#account-status').textContent}})()");
    check(signedInLayout.padding>=18 && signedInLayout.identity && signedInLayout.tabs && signedInLayout.settings && signedInLayout.status==='' && await evaluate("!document.querySelector('#account-menu-app-settings') && !document.querySelector('.app-settings-utility').hidden && document.querySelector('#settings-button').getClientRects().length===1"),'Account navigation clears transient sign-in status and keeps one reachable header Settings control '+JSON.stringify(signedInLayout));
    await evaluate(`(()=>{window.__savedLibraryCalls={plans:0,shopping:0};window.fetch=(input,options={})=>{const requestUrl=String(input);if(requestUrl.includes('/api/saved-items')&&(!options.method||options.method==='GET')){const shopping=requestUrl.includes('kind=shopping_list');window.__savedLibraryCalls[shopping?'shopping':'plans']++;const items=shopping?[{id:'shopping-1',kind:'shopping_list',name:'Current Shopping Session',updated_at:'2026-01-02T00:00:00Z',summary:{startingBudget:200,spent:42.25,remaining:157.75,purchaseCount:4}}]:[{id:'plan-1',kind:'grocery_plan',name:'Slow Grocery Plan',updated_at:'2026-01-01T00:00:00Z',summary:{budget:200,people:3,days:7,diet:'vegetarian',total:83.2,score:91}},{id:'meal-1',kind:'meal_plan',name:'Saved Meal Plan',updated_at:'2026-01-01T00:00:00Z',summary:{budget:200,people:3,days:7,diet:'vegetarian',total:83.2,score:91}}];return new Promise(resolve=>setTimeout(()=>resolve(new Response(JSON.stringify({items}),{status:200,headers:{'Content-Type':'application/json'}})),shopping?80:420));}return window.__accountRealFetch(input,options);};const plans=document.querySelector('[data-account-section=plans]'),shopping=document.querySelector('[data-account-section=shopping]');plans.click();shopping.click();return {heading:document.querySelector('#saved-library-title').textContent,loading:document.querySelector('#saved-items').textContent,selected:shopping.getAttribute('aria-selected'),busy:document.querySelector('#saved-items').getAttribute('aria-busy')};})()`);
    const immediateShopping=await evaluate("(()=>({heading:document.querySelector('#saved-library-title').textContent,text:document.querySelector('#saved-items').textContent,selected:document.querySelector('[data-account-section=shopping]').getAttribute('aria-selected'),busy:document.querySelector('#saved-items').getAttribute('aria-busy')}))()");
    check(immediateShopping.heading==='Your Saved Shopping Sessions'&&immediateShopping.text.includes('Loading saved shopping sessions')&&!immediateShopping.text.includes('Slow Grocery Plan')&&immediateShopping.selected==='true'&&immediateShopping.busy==='true','Shopping tab replaces old plan content immediately with an accessible loading state '+JSON.stringify(immediateShopping));
    await until(()=>evaluate("document.querySelector('.saved-item-card--shopping_list')?.querySelector('h4')?.textContent==='Current Shopping Session'"),'saved shopping session response');await delay(500);
    check(await evaluate("document.querySelector('#saved-library-title').textContent==='Your Saved Shopping Sessions' && document.querySelector('.saved-item-card--shopping_list') && !document.querySelector('.saved-item-card--grocery_plan') && !document.querySelector('#saved-items').hasAttribute('aria-busy')"),'Out-of-order plan response cannot render under Shopping Sessions');
    const cacheResult=await evaluate("(()=>{const before=window.__savedLibraryCalls.shopping;document.querySelector('[data-account-section=settings]').click();document.querySelector('[data-account-section=shopping]').click();return {before,after:window.__savedLibraryCalls.shopping,visible:document.querySelector('.saved-item-card--shopping_list')?.querySelector('h4')?.textContent};})()");
    check(cacheResult.before===cacheResult.after&&cacheResult.visible==='Current Shopping Session','Fresh tab cache avoids a repeat request and renders immediately '+JSON.stringify(cacheResult));
    await evaluate("(()=>{const tab=document.querySelector('[data-account-section=shopping]');tab.focus();tab.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));})()");
    check(await evaluate("document.activeElement.dataset.accountSection==='plans' && document.querySelector('[data-account-section=plans]').getAttribute('aria-selected')==='true' && document.querySelector('#saved-library-title').textContent==='Your Saved Plans'"),'Arrow-key tab navigation moves focus and selection together');
    await until(()=>evaluate("document.querySelectorAll('.saved-item-card').length===2"),'saved plan response');
    for(const [width,size,expectedColumns] of [[1440,'normal',3],[390,'normal',2],[390,'extra-large',2],[320,'normal',2],[320,'extra-large',2]]) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<=390});
      await evaluate(`NutriCartSettings.setSetting('textSize',${JSON.stringify(size)})`);await delay(100);
      const savedLayout=await evaluate("(()=>{const card=document.querySelector('.saved-item-card'),metrics=card.querySelector('.saved-metrics'),actionGroup=card.querySelector('.saved-item-actions'),actions=[...actionGroup.querySelectorAll('button')],r=card.getBoundingClientRect(),columns=getComputedStyle(metrics).gridTemplateColumns.split(' ').length,values=[...card.querySelectorAll('dd')];return {columns,height:r.height,actionHeight:actionGroup.getBoundingClientRect().height,noValueOverflow:values.every(value=>value.scrollWidth<=value.clientWidth+1&&getComputedStyle(value).whiteSpace==='nowrap'),actionsFit:actions.every(button=>{const b=button.getBoundingClientRect();return b.left>=r.left-1&&b.right<=r.right+1&&b.width>0&&getComputedStyle(button).whiteSpace==='nowrap'}),pageOverflow:document.documentElement.scrollWidth>innerWidth+1};})()");
      check(savedLayout.columns===expectedColumns&&savedLayout.noValueOverflow&&savedLayout.actionsFit&&savedLayout.actionHeight<=100&&savedLayout.height<650&&!savedLayout.pageOverflow,'Saved plan cards stay compact and adapt to their container at '+width+' '+size+' '+JSON.stringify(savedLayout));
    }
    await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:800,deviceScaleFactor:1,mobile:true});await evaluate("NutriCartSettings.setSetting('textSize','normal')");await delay(100);await evaluate("document.querySelector('[data-account-section=shopping]').click()");
    const shoppingLayout=await evaluate("(()=>{const card=document.querySelector('.saved-item-card--shopping_list'),r=card.getBoundingClientRect(),values=[...card.querySelectorAll('dd')],buttons=[...card.querySelectorAll('button')];return {columns:getComputedStyle(card.querySelector('.saved-metrics')).gridTemplateColumns.split(' ').length,noValueOverflow:values.every(value=>value.scrollWidth<=value.clientWidth+1),actionsFit:buttons.every(button=>{const b=button.getBoundingClientRect();return b.left>=r.left-1&&b.right<=r.right+1}),secondarySignOut:document.querySelector('#sign-out').closest('#account-settings-panel')!==null};})()");
    check(shoppingLayout.columns===2&&shoppingLayout.noValueOverflow&&shoppingLayout.actionsFit&&shoppingLayout.secondarySignOut,'Saved shopping session and Account Settings sign-out remain responsive '+JSON.stringify(shoppingLayout));
    await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await evaluate("NutriCartSettings.setSetting('textSize','normal')");
    await evaluate("window.fetch=window.__accountRealFetch;delete window.__accountRealFetch");await click('#account-close');
    await click('#settings-button');
    check(await evaluate("!document.querySelector('#settings-dialog').hidden && document.activeElement.id==='settings-close'"),'Signed-in header gear opens general Settings');
    await click('#settings-close');
    await click('#account-button');
    check(await evaluate("JSON.stringify([...document.querySelectorAll('#account-menu [role=menuitem]')].map(item=>item.textContent.trim()))===JSON.stringify(['My Plans','My Shopping Sessions','Account Settings','Sign Out'])"),'Signed-in account menu contains only account destinations and Sign Out');
    await click('#account-button');

    const restoredPlan=JSON.stringify(JSON.parse(planBeforeCompletion));
    await evaluate(`(()=>{const restored=${restoredPlan};restored.context.diet='omnivore';restored.result.planning_settings={...(restored.result.planning_settings||{}),diet:'omnivore'};window.__task73RestoredPlan=restored;document.dispatchEvent(new CustomEvent('nutricart:open-saved-plan',{detail:{data:restored,updated_at:'2026-01-01T00:00:00Z'}}))})()`);await delay(400);
    check(await evaluate("NutriCartWorkflow.get().basketReady && document.querySelector('#receipt-context').textContent.includes('Non-Vegetarian')"),'Old omnivore saved plan restores with Non-Vegetarian display');
    await evaluate("document.dispatchEvent(new CustomEvent('nutricart:open-saved-shopping',{detail:{id:'saved-session',data:{startingBudgetCents:10000,purchases:[{item:'Saved purchase',store:'',costCents:250,planned:false,estimated:false}],shoppingItems:[]}}}))");await delay(350);
    await evaluate("document.dispatchEvent(new CustomEvent('nutricart:open-saved-meal',{detail:{data:{context:window.__task73RestoredPlan.context,groceries:window.__task73RestoredPlan.result.groceries,mealPlan:{days_requested:1,rotation_days:1,repeats:false,days:[{day:1,meals:[{meal_type:'breakfast',title:'Saved meal',products:[]}],nutrition:{}}]}}}}))");await delay(350);
    check(await evaluate("!document.querySelector('#meal-plan-results').hidden && document.querySelector('#purchase-count').textContent==='1 item'"),'Restored Meal Plan and shopping session are visible before sign-out');
    await evaluate("window.__accountRealFetch=window.fetch;window.fetch=(input,options={})=>String(input).endsWith('/api/account/logout')?Promise.resolve(new Response(JSON.stringify({signed_out:true}),{status:200,headers:{'Content-Type':'application/json'}})):window.__accountRealFetch(input,options)");
    await click('#account-button');await click('#account-menu-sign-out');
    await until(()=>evaluate("document.querySelector('#account-button-label').textContent==='Sign In' && !document.querySelector('#home').hidden && document.querySelector('.locator').hidden && document.activeElement.id==='planner-title'"),'successful sign-out navigation');
    const signedOutState=await evaluate("(()=>({accountClosed:document.querySelector('#account-dialog').hidden,menuClosed:document.querySelector('#account-menu').hidden,libraryEmpty:document.querySelector('#saved-items').children.length===0,location:NutriCartLocation.get(),store:NutriCartStore.get(),workflow:NutriCartWorkflow.get(),mealHidden:document.querySelector('#meal-plan-results').hidden,purchases:document.querySelector('#purchase-count').textContent,settings:localStorage.getItem('nutricart:settings')}))()");
    check(signedOutState.accountClosed&&signedOutState.menuClosed&&signedOutState.libraryEmpty&&!signedOutState.location&&!signedOutState.store&&!signedOutState.workflow.basketReady&&!signedOutState.workflow.budgetReady&&signedOutState.mealHidden&&signedOutState.purchases==='0 items'&&await evaluate("document.querySelector('[data-account-section=plans]').getAttribute('aria-selected')==='true' && document.querySelector('#saved-library-title').textContent==='Your Saved Plans'"),'Sign-out clears restored account workflow state without exposing saved content '+JSON.stringify(signedOutState));
    await evaluate("window.fetch=window.__accountRealFetch;delete window.__accountRealFetch");

    await evaluate("window.__accountRealFetch=window.fetch;window.fetch=(input,options={})=>String(input).endsWith('/api/account/login')?Promise.resolve(new Response(JSON.stringify({user:{id:'11111111-1111-4111-8111-111111111111',email:'sample@example.test',first_name:'Sample',last_name:'Shopper',created_at:'now'}}),{status:200,headers:{'Content-Type':'application/json'}})):window.__accountRealFetch(input,options)");
    await click('#account-button');await evaluate("(()=>{document.querySelector('#sign-in-email').value='sample@example.test';document.querySelector('#sign-in-password').value='NutriCart10';document.querySelector('#sign-in-form').requestSubmit()})()");await until(()=>evaluate("!document.querySelector('#account-user-panel').hidden"),'second mocked sign-in');
    await evaluate("window.fetch=window.__accountRealFetch;delete window.__accountRealFetch");await click('#account-close');await click('#home-button');await delay(350);
    await evaluate("window.__signOutEvents=0;document.addEventListener('nutricart:account-signed-out',()=>window.__signOutEvents++);window.__accountRealFetch=window.fetch;window.fetch=(input,options={})=>String(input).endsWith('/api/account/logout')?Promise.resolve(new Response(JSON.stringify({error:'provider detail'}),{status:503,headers:{'Content-Type':'application/json'}})):window.__accountRealFetch(input,options)");
    await click('#account-button');await click('#account-menu-sign-out');await until(()=>evaluate("document.querySelector('#account-status').textContent.length>0"),'failed sign-out message');
    check(await evaluate("window.__signOutEvents===0 && document.querySelector('#account-status').textContent==='Sign out failed. Please try again.' && !document.querySelector('#account-user-panel').hidden && !document.querySelector('#home').hidden"),'Failed sign-out preserves the signed-in user and current Home view');
    await evaluate("window.fetch=window.__accountRealFetch;delete window.__accountRealFetch");await click('#account-close');
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
