(() => {
  // Event contracts:
  //   Listens: 'nutricart:plan-updated', 'nutricart:meal-rendered', 'nutricart:budget-state'
  //   Dispatches: 'nutricart:open-saved-plan', 'nutricart:open-saved-meal', 'nutricart:open-saved-shopping',
  //               'nutricart:request-budget-state', 'nutricart:navigate'
  const accountButton = document.querySelector("#account-button");
  if (!accountButton) return;
  const dialog = document.querySelector("#account-dialog");
  const backdrop = document.querySelector("#account-backdrop");
  const authPanel = document.querySelector("#account-auth-panel");
  const accountsEnabled = authPanel.dataset.accountsEnabled === "true";
  const userPanel = document.querySelector("#account-user-panel");
  const status = document.querySelector("#account-status");
  const saveDialog = document.querySelector("#save-dialog");
  const saveBackdrop = document.querySelector("#save-dialog-backdrop");
  const accountMenu = document.querySelector("#account-menu");
  const accountButtonLabel = document.querySelector("#account-button-label");
  const savedActionDialog = document.querySelector("#saved-action-dialog");
  const savedActionBackdrop = document.querySelector("#saved-action-backdrop");
  let csrfToken = "";
  let user = null;
  let currentPlan = null;
  let currentMeal = null;
  let pendingSave = null;
  let currentLibraryKind = "plans";
  const libraryCache = new Map();
  let libraryRequestRevision = 0;
  let libraryAbortController = null;
  let currentPlanSavedId = null;
  let savedAction = null;
  let authMode = "signin";
  let authRevision = 0;
  let authPending = false;
  let registrationRetryUntil = 0;
  let registrationRetryTimer = null;
  let registrationRetryMessage = "";
  let transientAuthStatus = false;
  const REGISTRATION_RETRY_DELAY_MS = 3000;
  const REGISTRATION_RATE_LIMIT_COOLDOWN_MS = 60000;
  const REGISTRATION_RATE_LIMIT_MESSAGE = "Too many account attempts. Please wait a moment before trying again.";

  function showGroceryPlanSaved(saved) {
    const button = document.querySelector("#save-grocery-plan");
    const indicator = document.querySelector("#grocery-plan-saved");
    button.textContent = "Save Plan";
    button.disabled = false;
    button.hidden = saved || !accountsEnabled;
    indicator.hidden = !saved;
  }

  function consumeAuthRedirectFragment() {
    const fragment = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    if (!fragment) return null;
    const values = new URLSearchParams(fragment);
    const isAuthRedirect = values.has("error") || values.has("error_code")
      || values.has("access_token") || values.has("refresh_token");
    if (!isAuthRedirect) return null;
    history.replaceState(null, "", window.location.pathname + window.location.search);
    const code = String(values.get("error_code") || "").toLowerCase();
    if (code === "otp_expired") {
      return {mode: "confirm", error: true, message: "This confirmation link is invalid or expired. Please request a new confirmation email."};
    }
    if (values.has("error")) {
      return {mode: "confirm", error: true, message: "Email confirmation could not be completed. Please request a new confirmation email."};
    }
    return {mode: "signin", error: false, message: "Email confirmed. Sign in to continue."};
  }

  const authRedirect = consumeAuthRedirectFragment();

  async function api(path, options = {}) {
    const headers = {...(options.headers || {})};
    if (options.body) headers["Content-Type"] = "application/json";
    if (options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrfToken;
    const response = await fetch(path, {...options, headers});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || "NutriCart could not complete that request."); error.status = response.status; throw error; }
    return data;
  }

  function setStatus(message, error = false, options = {}) {
    status.textContent = message; status.classList.toggle("error", error);
    transientAuthStatus = Boolean(message) && !error && options.transientAuth === true;
  }
  function clearTransientAuthStatus() {
    if (transientAuthStatus) setStatus("");
  }
  function showConfirmationAssistance(email = "") {
    document.querySelector("#resend-confirmation-mode").hidden = false;
    if (email) document.querySelector("#resend-confirmation-email").value = email;
  }

  function renderUser() {
    authPanel.hidden = Boolean(user); userPanel.hidden = !user;
    accountButtonLabel.textContent = user ? (user.first_name || "Account") : "Sign In";
    accountButton.classList.toggle("is-signed-in", Boolean(user));
    accountButton.setAttribute("aria-haspopup", user ? "menu" : "dialog");
    let avatar = accountButton.querySelector(".account-avatar");
    let chevron = accountButton.querySelector(".account-chevron");
    if (user) {
      if (!avatar) {
        avatar = document.createElement("span");
        avatar.className = "account-avatar";
        avatar.setAttribute("aria-hidden", "true");
        accountButton.insertBefore(avatar, accountButtonLabel);
      }
      avatar.textContent = (user.first_name || "N").charAt(0).toUpperCase();
      if (!chevron) {
        chevron = document.createElement("span");
        chevron.className = "account-chevron";
        chevron.setAttribute("aria-hidden", "true");
        chevron.textContent = "▾";
        accountButton.append(chevron);
      }
    } else {
      avatar?.remove();
      chevron?.remove();
    }
    if (!user) return;
    document.querySelector("#account-user-name").textContent = user.first_name || "NutriCart shopper";
    document.querySelector("#account-user-email").textContent = user.email;
    document.querySelector("#account-menu-name").textContent = [user.first_name, user.last_name].filter(Boolean).join(" ") || "NutriCart shopper";
    document.querySelector("#account-menu-email").textContent = user.email;
    document.querySelector("#profile-first-name").value = user.first_name || "";
    document.querySelector("#profile-last-name").value = user.last_name || "";
    document.querySelector("#profile-email").value = user.email;
  }

  function closeAccountMenu(restoreFocus = false) {
    accountMenu.hidden = true;
    accountButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) accountButton.focus();
  }

  function toggleAccountMenu() {
    const opening = accountMenu.hidden;
    accountMenu.hidden = !opening;
    accountButton.setAttribute("aria-expanded", String(opening));
    if (opening) accountMenu.querySelector('[role="menuitem"]').focus();
  }

  function openAccount(mode = "signin") {
    closeAccountMenu();
    dialog.scrollTop = 0;
    dialog.hidden = false; backdrop.hidden = false; document.body.classList.add("settings-open");
    if (!user && accountsEnabled) setAuthMode(mode);
    (accountsEnabled ? document.querySelector("#account-close") : document.querySelector("#continue-as-guest")).focus();
  }
  function closeAccount() { authRevision += 1; clearTransientAuthStatus(); dialog.hidden = true; backdrop.hidden = true; document.body.classList.remove("settings-open"); accountButton.focus(); }
  function setAuthMode(mode) {
    if (!accountsEnabled) return;
    authMode = mode;
    authRevision += 1;
    setStatus("");
    document.querySelector("#resend-confirmation-mode").hidden = true;
    const create = mode === "create";
    document.querySelector("#sign-in-form").hidden = mode !== "signin";
    document.querySelector("#create-account-form").hidden = !create;
    document.querySelector("#forgot-password-form").hidden = mode !== "forgot";
    document.querySelector("#resend-confirmation-form").hidden = mode !== "confirm";
    document.querySelector("#sign-in-intro").hidden = mode !== "signin";
    document.querySelector("#create-account-intro").hidden = !create;
    dialog.scrollTop = 0;
    if (create && registrationRetryActive()) setStatus(registrationRetryMessage, true);
  }

  async function refreshSession() {
    const data = await api("/api/account/session");
    csrfToken = data.csrf_token; user = data.user || null; renderUser();
  }

  function registrationRetryActive() {
    return Date.now() < registrationRetryUntil;
  }

  function holdRegistrationSubmit(milliseconds, message) {
    registrationRetryUntil = Math.max(registrationRetryUntil, Date.now() + milliseconds);
    registrationRetryMessage = message;
    const submit = document.querySelector("#create-account-submit");
    submit.disabled = true;
    window.clearTimeout(registrationRetryTimer);
    registrationRetryTimer = window.setTimeout(() => {
      if (!authPending && !registrationRetryActive()) {
        submit.disabled = false;
        registrationRetryMessage = "";
      }
    }, Math.max(0, registrationRetryUntil - Date.now()) + 25);
  }

  function registrationErrorMessage(error) {
    if (error.status === 429) return REGISTRATION_RATE_LIMIT_MESSAGE;
    if (!error.status) return "We could not reach account services. Check your connection and try again.";
    if (error.status >= 500) return "Account services are temporarily unavailable. Please wait a moment and try again.";
    return "We could not create the account. Check that your email is valid and your password meets the requirements, then try again.";
  }

  async function authenticate(path, payload) {
    const registering = path.endsWith("register");
    if (authPending) return;
    if (registering && registrationRetryActive()) {
      setStatus(registrationRetryMessage, true);
      return;
    }
    authPending = true;
    const authSubmits = document.querySelectorAll('#sign-in-form [type="submit"], #create-account-form [type="submit"]');
    authSubmits.forEach(control => { control.disabled = true; });
    const revision = ++authRevision;
    setStatus("");
    const form = registering ? document.querySelector("#create-account-form") : document.querySelector("#sign-in-form");
    const submit = form.querySelector('[type="submit"]');
    try {
      submit.disabled = true; submit.textContent = registering ? "Creating account..." : "Signing in...";
      const data = await api(path, {method: "POST", body: JSON.stringify(payload)});
      if (data.confirmation_required) {
        user = null;
        renderUser();
        if (revision === authRevision) {
          document.querySelector("#sign-in-email").value = payload.email || "";
          document.querySelector("#resend-confirmation-email").value = payload.email || "";
          setAuthMode("signin");
          showConfirmationAssistance(payload.email);
          setStatus("Check your email to confirm your account before signing in.");
        }
      } else {
        user = data.user; renderUser();
        if (revision === authRevision) {
          if (registering) setStatus("Welcome to NutriCart, " + user.first_name + ". Your account is ready.");
          else setStatus("Signed in. Your saved content is available on this device.", false, {transientAuth: true});
        }
        if (pendingSave) { closeAccount(); openSaveDialog(pendingSave); }
      }
    } catch (error) {
      if (revision === authRevision) {
        if (!registering && error.message === "Confirm your email before signing in.") showConfirmationAssistance(payload.email);
        if (registering) {
          const message = registrationErrorMessage(error);
          holdRegistrationSubmit(error.status === 429 ? REGISTRATION_RATE_LIMIT_COOLDOWN_MS : REGISTRATION_RETRY_DELAY_MS, message);
          setStatus(message, true);
        } else {
          setStatus(error.status ? error.message : "Sign in failed. Please try again.", true);
        }
      }
    }
    finally {
      authPending = false;
      authSubmits.forEach(control => {
        control.disabled = control.id === "create-account-submit" && registrationRetryActive();
      });
      submit.textContent = registering ? "Create Account" : "Sign In";
    }
  }

  function summaryForPlan(plan) {
    const context = plan.context || {}, result = plan.result || {};
    return {budget: context.budget, people: context.people, days: context.days, diet: context.diet,
      total: result.total_cost, score: result.quality_score};
  }

  function displayedDiet(value) {
    return value === "omnivore" ? "Non-Vegetarian" : (value || "Not listed");
  }

  const forbiddenSavedKeys = new Set([
    "latitude", "longitude", "coordinates", "address", "searched_address",
    "snap_results", "retailers", "price_results", "comparison_results",
    "access_token", "token", "credentials", "password", "password_hash",
  ]);

  function sanitizedSaveData(value) {
    if (Array.isArray(value)) return value.map(sanitizedSaveData);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !forbiddenSavedKeys.has(key.toLowerCase()))
      .map(([key, item]) => [key, sanitizedSaveData(item)]));
  }

  function openSaveDialog(save) {
    pendingSave = save;
    const guest = !user;
    saveDialog.hidden = false; saveBackdrop.hidden = false;
    document.querySelector("#save-dialog-title").textContent = guest ? "Save Your Plan" : save.title;
    document.querySelector("#save-dialog-copy").textContent = guest
      ? "Create a free NutriCart account to keep this for later."
      : "Choose a clear name so it is easy to find later.";
    document.querySelector("#save-name-wrap").hidden = guest;
    document.querySelector("#save-confirm").hidden = guest;
    document.querySelector("#save-create-account").hidden = !guest;
    document.querySelector("#save-sign-in").hidden = !guest;
    document.querySelector("#save-item-name").value = save.defaultName;
    document.querySelector("#save-status").textContent = "";
    (guest ? document.querySelector("#save-create-account") : document.querySelector("#save-item-name")).focus();
  }
  function closeSaveDialog() { saveDialog.hidden = true; saveBackdrop.hidden = true; pendingSave = null; }

  async function savePending() {
    if (!user || !pendingSave) return;
    const confirm = document.querySelector("#save-confirm");
    try {
      const name = document.querySelector("#save-item-name").value;
      confirm.disabled = true; confirm.textContent = "Saving...";
      const {item} = await api("/api/saved-items", {method: "POST", body: JSON.stringify({kind: pendingSave.kind, name, data: sanitizedSaveData(pendingSave.data)})});
      libraryCache.delete(pendingSave.kind === "shopping_list" ? "shopping_list" : "plans");
      if (pendingSave.kind === "grocery_plan") { currentPlanSavedId = item.id; showGroceryPlanSaved(true); }
      document.querySelector("#save-status").textContent = pendingSave.kind === "shopping_list" ? "✓ Shopping session saved" : pendingSave.kind === "meal_plan" ? "✓ Meal plan saved" : "✓ Plan saved";
      window.setTimeout(closeSaveDialog, 650);
    } catch (error) { document.querySelector("#save-status").textContent = `We couldn't save this right now. Your current work is still available. ${error.message}`; }
    finally { confirm.disabled = false; confirm.textContent = "Save"; }
  }

  function itemCard(item) {
    const article = document.createElement("article"); article.className = `saved-item-card saved-item-card--${item.kind}`;
    const headingWrap = document.createElement("div"); headingWrap.className = "saved-card-heading";
    const heading = document.createElement("h4"); heading.textContent = item.name;
    const kind = document.createElement("span"); kind.className = "saved-kind"; kind.textContent = item.kind === "shopping_list" ? "saved shopping session" : item.kind.replaceAll("_", " ");
    const date = document.createElement("p"); date.className = "saved-date"; date.textContent = `Saved ${new Intl.DateTimeFormat(undefined, {month: "short", day: "numeric", year: "numeric"}).format(new Date(item.updated_at))}`;
    headingWrap.append(kind, heading, date);
    const values = item.summary || {};
    const metrics = document.createElement("dl"); metrics.className = "saved-metrics";
    const money = value => `$${Number(value || 0).toFixed(2)}`;
    const entries = item.kind === "shopping_list"
      ? [["Starting budget", money(values.startingBudget)], ["Spent", money(values.spent)], ["Remaining", money(values.remaining)], ["Purchases", values.purchaseCount ?? 0]]
      : [["Budget", values.budget != null ? money(values.budget) : "—"], ["People", values.people ?? "—"], ["Days", values.days ?? "—"], ["Diet", displayedDiet(values.diet) || "—"], ["Saved total", values.total != null ? money(values.total) : "—"], ["Plan score", values.score != null ? Math.round(Number(values.score)) : "—"]];
    entries.forEach(([label, value]) => { const group = document.createElement("div"); const term = document.createElement("dt"); const detail = document.createElement("dd"); term.textContent = label; detail.textContent = value; group.append(term, detail); metrics.append(group); });
    const actions = document.createElement("div"); actions.className = "saved-item-actions";
    [[item.kind === "grocery_plan" ? "Open Plan" : item.kind === "meal_plan" ? "Open Meal Plan" : "Open Session", "open"], ["Rename", "rename"], ["Delete", "delete"]].forEach(([label, action]) => {
      const button = document.createElement("button"); button.type = "button"; button.dataset.savedAction = action; button.dataset.savedId = item.id; button.textContent = label; actions.append(button);
    });
    article.append(headingWrap, metrics, actions); return article;
  }

  function libraryState(message, error = false) {
    const state = document.createElement("div");
    state.className = `saved-library-state${error ? " error" : ""}`;
    state.setAttribute("role", "status");
    state.setAttribute("aria-live", "polite");
    state.textContent = message;
    return state;
  }

  function renderLibrary(kind, items) {
    if (kind !== currentLibraryKind) return;
    const output = document.querySelector("#saved-items");
    output.removeAttribute("aria-busy");
    output.replaceChildren(...items.map(itemCard));
    if (!items.length) {
      const empty = document.createElement("div"); empty.className = "saved-empty";
      const title = document.createElement("strong"); const copy = document.createElement("p"); const action = document.createElement("button");
      action.type = "button"; action.className = "secondary"; action.dataset.emptyView = kind === "shopping_list" ? "budget" : "planner";
      title.textContent = kind === "shopping_list" ? "No saved shopping sessions yet." : "No saved plans yet.";
      copy.textContent = kind === "shopping_list" ? "Track a shopping trip and save the session if you want to continue later." : "Build a Grocery Plan and save it here for later.";
      action.textContent = kind === "shopping_list" ? "Open Shopping Budget" : "Create Grocery Plan";
      empty.append(title, copy, action); output.append(empty);
    }
  }

  async function loadLibrary(kind = "plans", {refresh = false} = {}) {
    currentLibraryKind = kind;
    const output = document.querySelector("#saved-items");
    const cached = libraryCache.get(kind);
    if (cached) renderLibrary(kind, cached.items);
    if (cached && !refresh && Date.now() - cached.loadedAt < 30000) return;

    const revision = ++libraryRequestRevision;
    libraryAbortController?.abort();
    libraryAbortController = new AbortController();
    if (!cached) {
      output.setAttribute("aria-busy", "true");
      output.replaceChildren(libraryState(kind === "shopping_list" ? "Loading saved shopping sessions…" : "Loading saved plans…"));
    }
    try {
      const data = await api(kind === "plans" ? "/api/saved-items" : `/api/saved-items?kind=${encodeURIComponent(kind)}`, {signal: libraryAbortController.signal});
      const items = kind === "plans" ? data.items.filter(item => item.kind !== "shopping_list") : data.items;
      if (revision !== libraryRequestRevision || kind !== currentLibraryKind) return;
      libraryCache.set(kind, {items, loadedAt: Date.now()});
      renderLibrary(kind, items);
    } catch (error) {
      if (error.name === "AbortError" || revision !== libraryRequestRevision || kind !== currentLibraryKind) return;
      output.removeAttribute("aria-busy");
      if (!cached) output.replaceChildren(libraryState("We couldn't load your saved content. Try again.", true));
      setStatus("We couldn't load your saved content. Try again.", true);
    }
  }

  function selectAccountSection(section, {refresh = false} = {}) {
    clearTransientAuthStatus();
    const settings = section === "settings";
    const activeTab = document.querySelector(`[data-account-section="${section}"]`);
    document.querySelectorAll("[data-account-section]").forEach(button => {
      const selected = button.dataset.accountSection === section;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelector("#saved-library").hidden = settings;
    document.querySelector("#account-settings-panel").hidden = !settings;
    if (settings) {
      libraryRequestRevision += 1;
      libraryAbortController?.abort();
      return;
    }
    const kind = section === "shopping" ? "shopping_list" : "plans";
    document.querySelector("#saved-library").setAttribute("aria-labelledby", activeTab.id);
    document.querySelector("#saved-library-title").textContent = kind === "shopping_list" ? "Your Saved Shopping Sessions" : "Your Saved Plans";
    loadLibrary(kind, {refresh});
  }

  function closeSavedAction(restoreFocus = true) {
    const trigger = savedAction?.trigger;
    savedActionDialog.hidden = true; savedActionBackdrop.hidden = true; savedAction = null;
    if (restoreFocus && trigger?.isConnected) trigger.focus();
  }

  function openSavedAction(type, item, trigger) {
    savedAction = {type, item, trigger};
    const rename = type === "rename", accountDelete = type === "account-delete";
    document.querySelector("#saved-action-title").textContent = rename ? `Rename ${item.kind === "shopping_list" ? "Shopping Session" : "Plan"}` : accountDelete ? "Delete your account?" : `Delete “${item.name}”?`;
    document.querySelector("#saved-action-copy").textContent = rename ? "Choose a clear name for this saved item." : accountDelete ? "This permanently removes your account and all saved grocery plans, meal plans, and shopping sessions." : "This removes the saved copy from your account. Your current open plan will not be changed.";
    document.querySelector("#saved-action-name-wrap").hidden = !rename;
    document.querySelector("#saved-action-name").value = rename ? item.name : "";
    const confirm = document.querySelector("#saved-action-confirm"); confirm.disabled = false; confirm.textContent = rename ? "Save Name" : accountDelete ? "Delete Account" : item.kind === "shopping_list" ? "Delete Session" : "Delete Plan"; confirm.classList.toggle("destructive", !rename);
    document.querySelector("#saved-action-status").textContent = "";
    savedActionDialog.hidden = false; savedActionBackdrop.hidden = false;
    (rename ? document.querySelector("#saved-action-name") : confirm).focus();
  }

  async function confirmSavedAction() {
    if (!savedAction) return;
    const {type, item} = savedAction, confirm = document.querySelector("#saved-action-confirm"), output = document.querySelector("#saved-action-status");
    try {
      confirm.disabled = true; confirm.textContent = type === "rename" ? "Saving..." : "Deleting...";
      if (type === "rename") { const name = document.querySelector("#saved-action-name").value.trim(); if (!name) throw new Error("Enter a name before saving."); await api(`/api/saved-items/${item.id}`, {method: "PATCH", body: JSON.stringify({name})}); }
      else if (type === "delete") await api(`/api/saved-items/${item.id}`, {method: "DELETE"});
      else { await api("/api/account", {method: "DELETE", body: JSON.stringify({confirmation: "DELETE"})}); user = null; renderUser(); closeAccount(); }
      output.textContent = type === "rename" ? "Name updated." : type === "delete" ? "Saved item deleted." : "Account deleted.";
      if (type !== "account-delete") libraryCache.delete(currentLibraryKind);
      window.setTimeout(() => { closeSavedAction(false); if (type !== "account-delete") loadLibrary(currentLibraryKind, {refresh: true}); }, 350);
    } catch (error) { output.textContent = error.message; confirm.disabled = false; }
  }

  async function handleSavedAction(button) {
    const id = button.dataset.savedId, action = button.dataset.savedAction;
    try {
      if (action === "open") {
        const {item} = await api(`/api/saved-items/${id}`);
        const eventName = item.kind === "grocery_plan" ? "nutricart:open-saved-plan" : item.kind === "meal_plan" ? "nutricart:open-saved-meal" : "nutricart:open-saved-shopping";
        if (item.kind === "meal_plan") {
          const restoration = {item, restored: false, error: ""};
          document.dispatchEvent(new CustomEvent("nutricart:restore-saved-meal-basket", {detail: restoration}));
          if (!restoration.restored) throw new Error(restoration.error || "This saved Meal Plan could not restore its associated grocery basket.");
        }
        if (item.kind === "meal_plan") document.querySelector("#save-meal-plan").textContent = "Save as New Meal Plan";
        if (item.kind === "shopping_list") document.querySelector("#save-shopping-list").textContent = "Save as New Session";
        document.dispatchEvent(new CustomEvent(eventName, {detail: item}));
        if (item.kind === "grocery_plan") { currentPlanSavedId = item.id; showGroceryPlanSaved(true); }
        closeAccount();
      } else if (action === "rename") {
        openSavedAction("rename", {id, name: button.closest("article").querySelector("h4").textContent, kind: currentLibraryKind === "shopping_list" ? "shopping_list" : "grocery_plan"}, button);
      } else if (action === "delete") openSavedAction("delete", {id, name: button.closest("article").querySelector("h4").textContent, kind: currentLibraryKind === "shopping_list" ? "shopping_list" : "grocery_plan"}, button);
    } catch (error) { setStatus(error.message, true); }
  }

  document.addEventListener("nutricart:plan-updated", event => {
    const detail = event.detail || {};
    const result = {...(detail.result || {}), groceries: detail.plannedItems || []};
    currentPlan = {context: detail.context || {}, result};
    currentPlanSavedId = null;
    showGroceryPlanSaved(false);
  });
  document.addEventListener("nutricart:meal-rendered", event => { currentMeal = event.detail; document.querySelector("#save-meal-plan").textContent = "Save Meal Plan"; });
  document.addEventListener("nutricart:budget-state", event => {
    const purchases = event.detail.purchases || [];
    const startingBudget = event.detail.startingBudgetCents / 100;
    const spent = purchases.reduce((sum, purchase) => sum + Number(purchase.costCents || 0) / 100, 0);
    openSaveDialog({kind: "shopping_list", title: "Save Shopping Session", defaultName: "Shopping Session", data: {...event.detail, summary: {startingBudget, spent, remaining: startingBudget - spent, purchaseCount: purchases.length}}});
  });

  accountButton.addEventListener("click", () => { if (user) toggleAccountMenu(); else openAccount(); });
  accountMenu.addEventListener("keydown", event => {
    const items = [...accountMenu.querySelectorAll('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); closeAccountMenu(true); }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus(); }
  });
  document.addEventListener("click", event => { if (!event.target.closest(".account-menu-wrap")) closeAccountMenu(); });
  document.querySelectorAll("[data-account-menu-section]").forEach(button => button.addEventListener("click", () => { const section = button.dataset.accountMenuSection; openAccount(); document.querySelector(`[data-account-section="${section}"]`).click(); }));
  document.querySelector("#account-close").addEventListener("click", closeAccount); backdrop.addEventListener("click", closeAccount);
  if (accountsEnabled) {
    document.querySelector("#sign-in-mode").addEventListener("click", () => setAuthMode("signin"));
    document.querySelector("#create-account-mode").addEventListener("click", () => setAuthMode("create"));
    document.querySelector("#forgot-password-mode").addEventListener("click", () => {
      document.querySelector("#forgot-password-email").value = document.querySelector("#sign-in-email").value;
      setAuthMode("forgot"); document.querySelector("#forgot-password-email").focus();
    });
    document.querySelector("#forgot-back-to-sign-in").addEventListener("click", () => { setAuthMode("signin"); document.querySelector("#sign-in-email").focus(); });
    document.querySelector("#resend-confirmation-mode").addEventListener("click", () => {
      document.querySelector("#resend-confirmation-email").value = document.querySelector("#sign-in-email").value;
      setAuthMode("confirm"); document.querySelector("#resend-confirmation-email").focus();
    });
    document.querySelector("#confirmation-back-to-sign-in").addEventListener("click", () => { setAuthMode("signin"); document.querySelector("#sign-in-email").focus(); });
    document.querySelector("#forgot-password-form").addEventListener("submit", async event => {
      event.preventDefault();
      const revision = ++authRevision;
      const submit = event.target.querySelector('[type="submit"]');
      submit.disabled = true; setStatus("");
      try {
        const data = await api("/api/account/forgot-password", {method: "POST", body: JSON.stringify({email: document.querySelector("#forgot-password-email").value})});
        if (revision === authRevision && authMode === "forgot") setStatus(data.message);
      } catch (error) {
        if (revision === authRevision) setStatus(error.status ? error.message : "The request could not be sent. Please try again.", true);
      } finally { submit.disabled = false; }
    });
    document.querySelector("#sign-in-form").addEventListener("submit", event => { event.preventDefault(); authenticate("/api/account/login", {email: document.querySelector("#sign-in-email").value, password: document.querySelector("#sign-in-password").value}); });
    document.querySelector("#create-account-form").addEventListener("submit", event => {
      event.preventDefault();
      const form = event.currentTarget;
      const password = document.querySelector("#account-password");
      if (!window.NutriCartPasswords?.meetsRequirements(password.value) || !form.checkValidity()) {
        setStatus(window.NutriCartPasswords?.requirementMessage || "Use at least 10 characters and include both letters and numbers.", true);
        form.reportValidity();
        return;
      }
      authenticate("/api/account/register", {first_name: document.querySelector("#account-first-name").value, last_name: document.querySelector("#account-last-name").value, email: document.querySelector("#account-email").value, password: password.value, confirm_password: document.querySelector("#account-password-confirm").value});
    });
    document.querySelector("#resend-confirmation-form").addEventListener("submit", async event => {
      event.preventDefault();
      const revision = ++authRevision;
      const submit = event.target.querySelector('[type="submit"]');
      submit.disabled = true; setStatus("");
      try {
        const data = await api("/api/account/resend-confirmation", {method: "POST", body: JSON.stringify({email: document.querySelector("#resend-confirmation-email").value})});
        if (revision === authRevision && authMode === "confirm") setStatus(data.message);
      } catch (error) {
        if (revision === authRevision) setStatus(error.status ? error.message : "The request could not be sent. Please try again.", true);
      } finally { submit.disabled = false; }
    });
  } else {
    document.querySelector("#continue-as-guest").addEventListener("click", closeAccount);
  }
  function clearSignedInState() {
    user = null;
    currentPlan = null;
    currentMeal = null;
    currentPlanSavedId = null;
    currentLibraryKind = "plans";
    libraryRequestRevision += 1;
    libraryAbortController?.abort();
    libraryAbortController = null;
    libraryCache.clear();
    document.querySelector("#saved-items").replaceChildren();
    document.querySelector("#saved-library").hidden = false;
    document.querySelector("#saved-library").setAttribute("aria-labelledby", "account-plans-tab");
    document.querySelector("#saved-library-title").textContent = "Your Saved Plans";
    document.querySelector("#account-settings-panel").hidden = true;
    document.querySelectorAll("[data-account-section]").forEach(button => {
      const selected = button.dataset.accountSection === "plans";
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    ["#account-user-name", "#account-user-email", "#account-menu-name", "#account-menu-email"]
      .forEach(selector => { document.querySelector(selector).textContent = ""; });
    document.querySelector("#profile-form").reset();
    document.querySelector("#password-form").reset();
    document.querySelector("#save-meal-plan").textContent = "Save Meal Plan";
    document.querySelector("#save-shopping-list").textContent = "Save Shopping Session";
    closeSaveDialog();
    closeSavedAction(false);
    renderUser();
    showGroceryPlanSaved(false);
    setStatus("");
  }

  async function signOut() {
    try {
      await api("/api/account/logout", {method: "POST"});
    } catch (error) {
      closeAccountMenu();
      openAccount();
      setStatus("Sign out failed. Please try again.", true);
      return;
    }
    closeAccountMenu();
    closeAccount();
    clearSignedInState();
    document.dispatchEvent(new CustomEvent("nutricart:account-signed-out"));
  }
  document.querySelector("#sign-out").addEventListener("click", signOut);
  document.querySelector("#account-menu-sign-out").addEventListener("click", signOut);
  document.querySelector("#save-grocery-plan").addEventListener("click", () => { if (currentPlan) openSaveDialog({kind: "grocery_plan", title: "Save Grocery Plan", defaultName: `${currentPlan.context.days || 7}-Day Grocery Plan`, data: {...currentPlan, summary: summaryForPlan(currentPlan)}}); });
  document.querySelector("#save-meal-plan").addEventListener("click", () => { if (currentMeal) openSaveDialog({kind: "meal_plan", title: "Save Meal Plan", defaultName: `${currentMeal.mealPlan?.days_requested || currentPlan?.context?.days || 7}-Day Meal Plan`, data: {...currentMeal, groceries: currentPlan?.result?.groceries || [], summary: currentPlan ? summaryForPlan(currentPlan) : {}}}); });
  document.querySelector("#save-shopping-list").addEventListener("click", () => document.dispatchEvent(new Event("nutricart:request-budget-state")));
  document.querySelector("#save-confirm").addEventListener("click", savePending); document.querySelector("#save-cancel").addEventListener("click", closeSaveDialog); saveBackdrop.addEventListener("click", closeSaveDialog);
  document.querySelector("#saved-action-confirm").addEventListener("click", confirmSavedAction);
  document.querySelector("#saved-action-cancel").addEventListener("click", () => closeSavedAction());
  savedActionBackdrop.addEventListener("click", () => closeSavedAction());
  savedActionDialog.addEventListener("keydown", event => { if (event.key === "Escape") closeSavedAction(); });
  document.querySelector("#save-create-account").addEventListener("click", () => { saveDialog.hidden = true; saveBackdrop.hidden = true; openAccount("create"); });
  document.querySelector("#save-sign-in").addEventListener("click", () => { saveDialog.hidden = true; saveBackdrop.hidden = true; openAccount("signin"); });
  const accountSectionButtons = [...document.querySelectorAll("[data-account-section]")];
  accountSectionButtons.forEach(button => button.addEventListener("click", () => selectAccountSection(button.dataset.accountSection)));
  document.querySelector(".account-nav").addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = accountSectionButtons.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? accountSectionButtons.length - 1
      : (current + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + accountSectionButtons.length) % accountSectionButtons.length;
    accountSectionButtons[next].focus();
    accountSectionButtons[next].click();
  });
  document.querySelector("#saved-items").addEventListener("click", event => { const button = event.target.closest("[data-saved-action]"); if (button) handleSavedAction(button); });
  document.querySelector("#saved-items").addEventListener("click", event => { const button = event.target.closest("[data-empty-view]"); if (button) { closeAccount(); document.dispatchEvent(new CustomEvent("nutricart:navigate", {detail: {view: button.dataset.emptyView}})); } });
  document.addEventListener("nutricart:navigate", clearTransientAuthStatus);
  document.querySelector("#profile-form").addEventListener("submit", async event => { event.preventDefault(); try { const data = await api("/api/account/profile", {method: "PATCH", body: JSON.stringify({first_name: document.querySelector("#profile-first-name").value, last_name: document.querySelector("#profile-last-name").value})}); user = data.user; renderUser(); setStatus("✓ Profile updated"); } catch (error) { setStatus(error.message, true); } });
  document.querySelector("#password-form").addEventListener("submit", async event => { event.preventDefault(); try { await api("/api/account/change-password", {method: "POST", body: JSON.stringify({current_password: document.querySelector("#current-password").value, new_password: document.querySelector("#new-password").value, confirm_password: document.querySelector("#confirm-new-password").value})}); event.target.reset(); setStatus("Password updated."); } catch (error) { setStatus(error.message, true); } });
  document.querySelector("#delete-account")?.addEventListener("click", event => openSavedAction("account-delete", {name: "account", kind: "account"}, event.currentTarget));
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); closeAccount(); return; }
    if (event.key !== "Tab") return;
    const controls = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      .filter(control => !control.closest("[hidden]") && control.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  refreshSession().then(() => {
    if (authRedirect && accountsEnabled && !user) {
      openAccount(authRedirect.mode);
      setStatus(authRedirect.message, authRedirect.error);
      return;
    }
    const address = new URL(window.location.href);
    if (address.searchParams.get("signin") === "1") {
      address.searchParams.delete("signin"); history.replaceState(null, "", address.pathname + address.search + address.hash);
      openAccount();
    }
  }).catch(() => { accountButtonLabel.textContent = "Sign In"; });
})();
