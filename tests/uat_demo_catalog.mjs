// Run: node tests/uat_demo_catalog.mjs (starts an isolated local Flask server)
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
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

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  assert.equal(new URL(url).hostname, '127.0.0.1', 'UAT must use the local NutriCart server');
  {
  server = spawn(pythonPath, ["-B", "-m", "flask", "--app", "app", "run", "--host", "127.0.0.1", "--port", String(port), "--no-reload"], {
    cwd: root, windowsHide: true,
    env: {...process.env, NUTRICART_CATALOG_MODE: "demo", NUTRICART_DATABASE: path.join(runtime, "accounts.db"), FLASK_DEBUG: "0", PYTHONDONTWRITEBYTECODE: "1",
      PYTHON_DOTENV_DISABLED: "1", FLASK_SKIP_DOTENV: "1"},
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", chunk => { serverOutput += chunk; });
  server.stderr.on("data", chunk => { serverOutput += chunk; });
  }
  await until(async () => { try { return (await localGet(url)).status === 200; } catch { return false; } }, "Flask readiness");
  for (const asset of ['settings.js','grocery.js','styles.css']) {
    const served=await localGet(url+'/static/'+asset+'?verify=task18-final');
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




  const checks=[], assets=[];
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Network.responseReceived' && m.params.response.url.includes('/static/')) assets.push({url:new URL(m.params.response.url).pathname,status:m.params.response.status});});
  await cdp('Network.enable');await cdp('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp('Page.reload',{ignoreCache:true});await delay(1200);
  const check=(value,name)=>{assert(value,name);checks.push(name);console.log('PASS:',name);};
  async function click(selector){
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await delay(150);
    const box=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});await delay(500);
  }
  const fill=values=>evaluate(`(()=>{for(const [id,value] of Object.entries(${JSON.stringify(values)})){const n=document.getElementById(id);n.value=value;n.dispatchEvent(new Event('input',{bubbles:true}));}})()`);

  const layouts=[];
  async function layout(selector,name){
    for(const width of [1440,1280,768,390]) for(const size of ['normal','large','extra-large']) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===390});
      await evaluate(`NutriCartSettings.setSetting('textSize',${JSON.stringify(size)})`);await delay(100);
      const state=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return {overflow:document.documentElement.scrollWidth>innerWidth+1,clipped:[...n.querySelectorAll('button,input,select')].filter(x=>x.getClientRects().length && x.scrollWidth>x.clientWidth+3).map(x=>x.id)}})()`);
      assert(!state.overflow && !state.clipped.length,JSON.stringify({name,width,size,state}));layouts.push({name,width,size});if(width===390 && size==='extra-large'){const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(artifacts,name+'-390.png'),Buffer.from(shot.data,'base64'));}
    }
    await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await evaluate("NutriCartSettings.setSetting('textSize','normal')");
  }
  await evaluate("NutriCartSettings.setSetting('cursorEffects',false);document.addEventListener('nutricart:plan-updated',e=>window.task16Plan={context:e.detail.context,result:e.detail.result})");
  check(await evaluate("document.querySelectorAll('.hero-actions button').length===1 && document.querySelector('#hero-find-snap').textContent===\"Let's get started\""),'Home unchanged');
  check(await evaluate("document.querySelector('#home-button svg') && document.querySelector('.footer-brand svg') && document.querySelector('link[rel=icon]').href.startsWith('data:image/svg+xml')"),'Original basket logo in header footer and favicon');
  await click('#planner-tab');
  check(await evaluate("document.querySelector('#planner-form').hidden && !document.querySelector('#planner-location-gate').hidden"),'Fresh guest sees location gate instead of form');
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
  await cdp('Page.reload',{ignoreCache:true});await delay(800);
  check(await evaluate("NutriCartSettings.getSetting('snapRadius')===10 && !document.querySelector('#home').hidden"),'Preferences persist and reload always starts Home');
  await evaluate("localStorage.setItem('nutricart.settings.v2',JSON.stringify({rememberSettings:true,textSize:'small',startingView:'budget',cursorEffects:true,confirmBeforeClear:false,snapRadius:25,privateUnknown:'must-disappear'}))");
  await cdp('Page.reload',{ignoreCache:true});await delay(800);
  check(await evaluate("!document.querySelector('#home').hidden && NutriCartSettings.getSetting('textSize')==='normal' && NutriCartSettings.getSetting('confirmBeforeClear')===true && !JSON.parse(localStorage.getItem('nutricart.settings.v2')).privateUnknown"),'Legacy keys ignored and removed; safe defaults restored');
  await click('#settings-button');await click('.settings-category:nth-child(4) summary');
  let dialogAnswer=false,dialogSeen=0;
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Page.javascriptDialogOpening'){dialogSeen++;cdp('Page.handleJavaScriptDialog',{accept:dialogAnswer}).catch(()=>{});}});
  await click('#clear-saved-settings');check(await evaluate("!!localStorage.getItem('nutricart.settings.v2')"),'Cancel preserves saved preferences');
  dialogAnswer=true;await click('#clear-saved-settings');
  check(await evaluate("!localStorage.getItem('nutricart.settings.v2') && document.querySelector('#clear-saved-settings').hidden"),'Confirmed clear removes preferences only');
  await click('#settings-close');
  await evaluate("NutriCartSettings.setSetting('snapRadius',5)");
  await cdp('Page.reload',{ignoreCache:true});await delay(800);
  check(await evaluate("NutriCartSettings.getSetting('snapRadius')===5 && !NutriCartSettings.getSetting('rememberSettings')"),'Disabled persistence does not survive reload');
  await evaluate("document.addEventListener('nutricart:plan-updated',e=>window.task16Plan={context:e.detail.context,result:e.detail.result})");
  await click('#meal-plan-tab');
  check(await evaluate("!document.querySelector('#meal-plan-empty').hidden && document.querySelector('#meal-empty-title').textContent==='Build a grocery basket to plan your meals.'"),'Compact meal empty state');
  await layout('#meal-plan-view','meal-empty');
  await click('#shopping-budget-tab');
  check(await evaluate("document.querySelector('#view-shopping-list').hidden"),'No shopping link without a basket');
  await click('#home-button');await click('#hero-find-snap');
  check(await evaluate("!document.querySelector('.locator').hidden"),'Start opens SNAP');
  await cdp('Browser.grantPermissions',{origin:url,permissions:['geolocation']});
  await cdp('Emulation.setGeolocationOverride',{latitude:61.2181,longitude:-149.9003,accuracy:50});
  await click('#location-button');
  await until(()=>evaluate("!document.querySelector('#location-button').disabled && !!NutriCartLocation.get() && !document.querySelector('#snap-build-basket').hidden"),'current location with real SNAP response',90000);
  check(true,'Current location responds and resolves a planning location (emulated public test position)');
  // Use the real address endpoint and store lookup. This is a public test address.
  await fill({address:'142 W Fifth Ave, Anchorage, AK 99501'});await click('#address-button');
  await until(()=>evaluate("!document.querySelector('#snap-build-basket').hidden && !document.querySelector('#address-button').disabled"),'real SNAP results',90000);
  await click('#snap-build-basket');
  check(await evaluate("document.querySelector('#planner-location-gate').hidden && !document.querySelector('#change-planning-location').hidden && !document.querySelector('#planner-form').hidden"),'Valid location reveals form and subtle change action');
  await layout('#planner-view','planner-before');
  check(await evaluate("document.querySelector('#planner-essentials').getClientRects().length>0 && !document.querySelector('#planner-form').hidden"),'Planner heading and form visible before generation');
  async function generate(diet,budget){
    await fill({budget:String(budget),people:'3',days:'1',calories:'2000',protein:'50'});
    await click(`input[name=diet][value=${diet}]`);
    await until(()=>evaluate("!document.querySelector('#review-plan').disabled"),'review enabled',60000);
    await click('#review-plan');await click('#generate-plan');
    await until(()=>evaluate("!document.querySelector('#plan-results').hidden && document.querySelector('#grocery-plan-loader').hidden"),'real basket',120000);
    check(await evaluate("document.querySelector('#plan-results-title').textContent==='Your Grocery Basket' && document.querySelector('#planner-essentials').getClientRects().length===0 && !document.querySelector('#basket-location')"),diet+': one result heading/location');
    check(await evaluate(`document.querySelector('#receipt-context').textContent.includes('${diet[0].toUpperCase()+diet.slice(1)}') && document.querySelector('#receipt-context').textContent.includes('3 people') && document.querySelector('#receipt-context').textContent.includes('1 day')`),diet+': compact truthful summary');
  }
  // Same real resolved location and nutrition settings for both diets.
  await generate('vegan',500.45);check(await evaluate("window.task16Plan.result.groceries.every(p=>p.product_id.startsWith('demo-')) && document.querySelector('#grocery-list').textContent.length>0"),'Independent demo products only');check(await evaluate("document.querySelector('#receipt-price-source').textContent.includes('Example grocery prices')"),'Synthetic price disclosure');await layout('#planner-view','vegan-basket');
  await click('#edit-plan');check(await evaluate("!document.querySelector('#planner-form').hidden && document.querySelector('#budget').value==='500.45'"),'Edit retains original form inputs');
  await generate('vegetarian',500.45);
  await click('#alternative-plan');await until(()=>evaluate("document.querySelector('#grocery-plan-loader').hidden && !document.querySelector('#alternative-plan').disabled"),'alternative complete',120000);
  check(await evaluate("!document.querySelector('#plan-results').hidden && document.querySelector('#plan-results-title').textContent==='Your Grocery Basket' && document.querySelector('#planner-essentials').getClientRects().length===0"),'Alternative keeps single result heading');
  await click('#open-meal-from-plan');await until(()=>evaluate("!document.querySelector('#meal-plan-results').hidden"),'real meals',60000);
  await layout('#meal-plan-view','generated-meals');
  check(await evaluate("document.querySelectorAll('#meal-plan-view h1').length===1 && document.querySelector('#meal-open-budget').textContent==='Track My Shopping'"),'Generated meals retain explicit shopping action');
  await click('#meal-open-budget');
  await layout('#shopping-budget-view','shopping');
  check(await evaluate("!document.querySelector('#view-shopping-list').hidden && document.querySelector('#purchase-form h2').textContent==='Record What You Bought'"),'Purchase entry and shopping link visible');
  await fill({'purchase-item':'Regression groceries','purchase-cost':'3.50'});
  await evaluate("document.querySelector('#view-shopping-list').focus()");
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await delay(700);
  check(await evaluate("document.activeElement.id==='shopping-list-panel' && document.querySelector('#purchase-cost').value==='3.50'"),'Keyboard list link moves focus and preserves purchase input');
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await click('#view-shopping-list');
  check(await evaluate("document.activeElement.id==='shopping-list-panel' && document.querySelector('#shopping-list-panel').getBoundingClientRect().top<innerHeight"),'Reduced-motion list link reaches actual list');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:true});
  await evaluate("document.querySelector('#view-shopping-list').scrollIntoView({behavior:'instant',block:'center'})");await delay(200);
  const touch=await evaluate("(()=>{const r=document.querySelector('#view-shopping-list').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch]});await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(300);
  check(await evaluate("document.activeElement.id==='shopping-list-panel'"),'Mobile touch list navigation');
  const state=async()=>{const value=await evaluate("new Promise(resolve=>{document.addEventListener('nutricart:budget-state',e=>resolve(e.detail),{once:true});document.dispatchEvent(new Event('nutricart:request-budget-state'))})");await evaluate("if(!document.querySelector('#save-dialog').hidden) document.querySelector('#save-cancel').click()");return value;};
  const before=await state();
  await click('#select-all-shopping');const collected=await state();
  check(JSON.stringify(before.purchases)===JSON.stringify(collected.purchases),'Collecting does not record purchases');
  await click('#add-purchase');const bought=await state();
  check(bought.purchases.length===before.purchases.length+1,'Explicit purchase recorded');
  const storedBeforeClear=await evaluate("document.querySelector('#purchase-log').textContent");
  dialogAnswer=false;await click('#clear-purchases');
  check(dialogSeen>=3 && await evaluate("document.querySelector('#purchase-log').textContent")===storedBeforeClear,'Clearing purchases always asks and cancel preserves them');

  check(bought.startingBudgetCents===before.startingBudgetCents && bought.purchases.at(-1).costCents===350,'Purchase updates spending by exactly $3.50');
  await click('#planner-tab');
  // Capture the same payload consumed by the existing save/restore UI.
  const saved=await evaluate("window.task16Plan");
  assert(saved.context && saved.result.groceries.length);
  await evaluate(`document.dispatchEvent(new CustomEvent('nutricart:open-saved-plan',{detail:{data:${JSON.stringify(saved)},updated_at:'2026-10-02T12:00:00Z'}}))`);await delay(600);
  check(await evaluate("!document.querySelector('#plan-results').hidden && document.querySelector('#planner-essentials').getClientRects().length===0"),'Saved basket restore uses same compact result');
  await click('#shopping-budget-tab');const restored=await state();
  check(JSON.stringify(restored.purchases)===JSON.stringify(bought.purchases),'Restoring basket preserves purchases');
  check(await evaluate("fetch('/api/account/session').then(r=>r.json()).then(r=>!r.authenticated)"),'Guest session works');
  check(await evaluate("fetch('/api/saved-items').then(r=>r.status===503)"),'Cloud save explicitly unavailable');
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
  check(await evaluate("document.querySelector('#planner-form').hidden && !document.querySelector('#planner-location-gate').hidden"),'Cleared location gates form again without losing purchases');
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
  check(assets.length>0 && assets.every(a=>a.status===200),'All static assets load');
  check(browserErrors.length===0,'Zero console errors');
  await writeFile(path.join(artifacts,'results.json'),JSON.stringify({checks,layouts,browserErrors},null,2));
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
