(() => {
  // Only useful preferences are editable or persisted. Legacy keys are ignored.
  const STORAGE_KEY = "nutricart.settings.v2";
  const DEFAULT_SETTINGS = Object.freeze({textSize: "normal", highContrast: false,
    usePlannerBudget: true, snapRadius: 5, rememberSettings: false});
  // Compatibility defaults for existing controllers; these cannot be overridden
  // by old browser storage or by setSetting().
  const FIXED = Object.freeze({startingView: "home", density: "comfortable",
    cursorEffects: false, cursorTrail: false, clickEffects: false, transitions: "subtle",
    cinematicIntros: false, animatedNumbers: false, confirmBeforeClear: true,
    defaultDiet: "none", defaultPlanPriority: "balanced", defaultNutritionFocus: "none",
    advancedPlannerDefault: "collapsed", mealView: "detailed",
    priceDefaultStoreSelection: "all", priceReferenceStore: "", approximateAddressDisplay: false});
  const ALLOWED = Object.freeze({textSize: ["normal", "large", "extra-large"], snapRadius: [5, 10, 25, 50]});
  const BOOLEAN_KEYS = new Set(["highContrast", "usePlannerBudget", "rememberSettings"]);
  let storageFailed = false;
  let settings = {...DEFAULT_SETTINGS};

  function sanitize(candidate) {
    const safe = {...DEFAULT_SETTINGS};
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return safe;
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
      const value = candidate[key];
      if (BOOLEAN_KEYS.has(key) && typeof value === "boolean") safe[key] = value;
      else if (ALLOWED[key]?.includes(key === "snapRadius" ? Number(value) : value)) safe[key] = key === "snapRadius" ? Number(value) : value;
    });
    return safe;
  }

  function loadSavedSettings() {
    try {
      const saved = sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
      if (saved.rememberSettings) settings = saved;
    } catch (_error) { settings = {...DEFAULT_SETTINGS}; }
    return {...settings};
  }

  function approvedSettings() {
    return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, settings[key]]));
  }

  function saveSettings() {
    try {
      if (!settings.rememberSettings) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(approvedSettings()));
      storageFailed = false;
    } catch (_error) { storageFailed = true; }
  }

  function applySettings() {
    const root = document.documentElement;
    root.dataset.density = FIXED.density;
    root.dataset.textSize = settings.textSize;
    root.dataset.highContrast = String(settings.highContrast);
    root.dataset.transitionMode = FIXED.transitions;
    root.dataset.mealView = FIXED.mealView;
    root.dataset.cinematicIntros = String(FIXED.cinematicIntros);
    root.dataset.animatedNumbers = String(FIXED.animatedNumbers);
  }

  function announceChange(key) {
    document.dispatchEvent(new CustomEvent("nutricart:settings-changed", {detail: {key, settings: {...settings}}}));
  }

  function getSetting(key) { return settings[key] ?? FIXED[key]; }

  function setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) return false;
    const next = sanitize({...settings, [key]: value});
    settings = next;
    applySettings();
    saveSettings();
    syncControls();
    announceChange(key);
    return true;
  }

  function clearSavedSettings() {
    if (!window.confirm("Clear saved app preferences? Your plans, purchases, and account will stay unchanged.")) return;
    try { localStorage.removeItem(STORAGE_KEY); storageFailed = false; }
    catch (_error) { storageFailed = true; syncControls(); return; }
    settings.rememberSettings = false;
    syncControls();
    applySettings();
    announceChange("rememberSettings");
  }

  function resetSettings() {
    if (!window.confirm("Reset app preferences? Your plans, purchases, and account will stay unchanged.")) return;
    settings = {...DEFAULT_SETTINGS};
    applySettings();
    saveSettings();
    syncControls();
    announceChange("reset");
  }

  const button = document.querySelector("#settings-button");
  const menuButton = document.querySelector("#account-menu-app-settings");
  let returnFocus = button;
  const dialog = document.querySelector("#settings-dialog");
  const backdrop = document.querySelector("#settings-backdrop");
  const closeButton = document.querySelector("#settings-close");
  const form = document.querySelector("#settings-form");
  const persistenceStatus = document.querySelector("#settings-persistence-status");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function syncControls() {
    form.querySelectorAll("[data-setting]").forEach(control => {
      const value = settings[control.dataset.setting];
      if (control.type === "checkbox") control.checked = Boolean(value);
      else if (control.type === "radio") control.checked = control.value === String(value);
      else control.value = String(value);
    });
    persistenceStatus.textContent = storageFailed ? "Preferences could not be saved in this browser." : settings.rememberSettings
      ? "Preferences are saved in this browser."
      : "Preferences are not saved for future visits.";
    document.querySelector("#system-motion-note").hidden = !reducedMotion.matches;
    try { document.querySelector("#clear-saved-settings").hidden = !localStorage.getItem(STORAGE_KEY); }
    catch (_error) { document.querySelector("#clear-saved-settings").hidden = true; }
  }

  function focusableControls() {
    return [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')].filter(control => control.getClientRects().length);
  }

  function openSettings(event) {
    returnFocus = event?.currentTarget === menuButton ? document.querySelector("#account-button") : button;
    dialog.hidden = false; backdrop.hidden = false;
    document.body.classList.add("settings-open");
    closeButton.focus();
  }

  function closeSettings() {
    if (dialog.hidden) return;
    dialog.hidden = true; backdrop.hidden = true;
    document.body.classList.remove("settings-open");
    returnFocus.focus();
  }

  button.addEventListener("click", openSettings);
  menuButton.addEventListener("click", openSettings);
  closeButton.addEventListener("click", closeSettings);
  backdrop.addEventListener("click", closeSettings);
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); closeSettings(); return; }
    if (event.key !== "Tab") return;
    const controls = focusableControls();
    const first = controls[0]; const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  form.addEventListener("change", event => {
    const control = event.target.closest("[data-setting]");
    if (!control) return;
    if (control.type === "radio" && !control.checked) return;
    setSetting(control.dataset.setting, control.type === "checkbox" ? control.checked : control.value);
  });
  document.querySelector("#clear-saved-settings").addEventListener("click", clearSavedSettings);

  reducedMotion.addEventListener?.("change", syncControls);

  loadSavedSettings(); saveSettings(); applySettings(); syncControls();
  window.NutriCartSettings = Object.freeze({DEFAULT_SETTINGS, getSetting, setSetting, loadSavedSettings, saveSettings,
    resetSettings, clearSavedSettings, applySettings});
})();
