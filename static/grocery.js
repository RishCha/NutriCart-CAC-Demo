(() => {
  // NutriCart Grocery Planner & View Navigation Controller
  // Authoritative manager for grocery planning, optimizer requests, and top-level tabbed views.
  // Event contracts:
  //   Dispatches: 'nutricart:plan-updated', 'nutricart:budget-opened', 'nutricart:create-meal-plan'
  //   Listens: 'nutricart:navigate', 'nutricart:open-saved-plan'
  const plannerTab = document.querySelector("#planner-tab");
  const mealTab = document.querySelector("#meal-plan-tab");
  const budgetTab = document.querySelector("#shopping-budget-tab");
  const snapTab = document.querySelector("#snap-tab");
  const plannerView = document.querySelector("#planner-view");
  const mealView = document.querySelector("#meal-plan-view");
  const budgetView = document.querySelector("#shopping-budget-view");
  const snapView = document.querySelector("#snap-view");
  const form = document.querySelector("#planner-form");
  const plannerCard = document.querySelector("#planner-view .planner-card");
  const plannerGate = document.querySelector("#planner-location-gate");
  const mealHeading = document.querySelector("#meal-plan-view .meal-plan-heading");
  const mealEmpty = document.querySelector("#meal-plan-empty");
  const mealReady = document.querySelector("#meal-plan-ready");
  const mealResults = document.querySelector("#meal-plan-results");
  const mealLockedAction = document.querySelector("#create-plan-from-meals");
  const budgetLocked = document.querySelector("#shopping-budget-locked");
  const budgetLockedAction = document.querySelector("#budget-locked-action");
  const budgetDashboard = document.querySelector("#budget-dashboard");

  // This is the authoritative planner submit path. Bind it before querying or
  // wiring optional cross-feature UI so both button and Enter-key submissions
  // are intercepted even if a later enhancement cannot initialize.
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (validatedInputs()) generate(false, event.submitter || document.querySelector("#review-plan"));
  });

  const reviewSection = document.querySelector("#review-section");
  const reviewDetails = document.querySelector("#review-details");
  const resultsSection = document.querySelector("#plan-results");
  const plannerError = document.querySelector("#planner-error");
  const plannerStatus = document.querySelector("#planner-status");
  const planError = document.querySelector("#plan-error");
  const generateStatus = document.querySelector("#generate-status");
  const groceryLoader = document.querySelector("#grocery-plan-loader");
  const groceryLoaderStatus = document.querySelector("#grocery-loader-status");
  const groceryLoaderProgress = document.querySelector("#grocery-loader-progress");
  const groceryLoaderFill = document.querySelector("#grocery-loader-fill");
  const groceryLoaderPercent = document.querySelector("#grocery-loader-percent");
  const budgetInput = document.querySelector("#budget");
  const peopleInput = document.querySelector("#people");
  const daysInput = document.querySelector("#days");
  const dietInputs = [...form.querySelectorAll('input[name="diet"]')];
  const dietOptions = document.querySelector("#diet-options");
  const caloriesInput = document.querySelector("#calories");
  const proteinInput = document.querySelector("#protein");
  const customFiberInput = document.querySelector("#fiber-custom");
  const generateButton = document.querySelector("#generate-plan");
  const submitButton = document.querySelector("#review-plan");
  const feasibilityElements = {
    budget: document.querySelector("#budget-feasibility"),
    people: document.querySelector("#people-feasibility"),
    days: document.querySelector("#days-feasibility"),
    status: document.querySelector("#feasibility-status"),
  };
  const GENERAL_NUTRITION_TARGETS = Object.freeze({calories: 2000, protein: 50});
  let suggestedTargetsApplied = false;
  const alternativeButton = document.querySelector("#alternative-plan");
  let reviewedInputs = null;
  let currentResult = null;
  let currentPlan = null;
  let budgetSessionReady = false;
  let activeGeneration = null;
  let alternativeHistory = [];
  let activeView = snapView;
  let viewTransitioning = false;
  let feasibilityTimer = null;
  let feasibilityController = null;
  let feasibilityRequest = 0;
  let currentFeasibility = null;
  const feasibilityCache = new Map();

  function hasPlanningLocation() {
    const location = window.NutriCartLocation?.get();
    return Boolean(location && [location.locality, location.region].some(value => typeof value === "string" && value.trim()));
  }

  function hasPlanningStore() {
    const store = window.NutriCartStore?.get();
    return Boolean(store && (store.record_id !== null || [store.name, store.city, store.region].some(value => typeof value === "string" && value.trim())));
  }

  function hasCurrentBasket() {
    return Boolean(currentResult?.groceries?.length);
  }

  function setTabLock(tab, locked, lockedLabel, unlockedLabel) {
    tab.classList.toggle("is-workflow-locked", locked);
    tab.querySelector(".nav-lock-indicator")?.toggleAttribute("hidden", !locked);
    tab.setAttribute("aria-label", locked ? lockedLabel : unlockedLabel);
  }

  function nextRequiredStep() {
    return hasPlanningLocation() && hasPlanningStore()
      ? {view: "planner", label: "Build My Grocery Plan"}
      : {view: "snap", label: "Find SNAP Stores"};
  }

  function updateWorkflowState() {
    const basketReady = hasCurrentBasket();
    const plannerReady = basketReady || (hasPlanningLocation() && hasPlanningStore());
    const budgetReady = basketReady || budgetSessionReady;
    const next = nextRequiredStep();

    plannerGate.hidden = plannerReady;
    plannerCard.hidden = !plannerReady;
    document.querySelector("#change-planning-location").hidden = !hasPlanningLocation();
    if (!plannerReady) {
      form.hidden = true;
      reviewSection.hidden = true;
    } else if (!basketReady && resultsSection.hidden && reviewSection.hidden && groceryLoader.hidden) {
      form.hidden = false;
    }

    mealHeading.hidden = !basketReady;
    if (!basketReady) {
      mealEmpty.hidden = false;
      mealReady.hidden = true;
      mealResults.hidden = true;
      mealLockedAction.dataset.workflowTarget = next.view;
      mealLockedAction.textContent = next.label;
    }

    budgetLocked.hidden = budgetReady;
    budgetDashboard.hidden = !budgetReady;
    budgetLockedAction.dataset.workflowTarget = next.view;
    budgetLockedAction.textContent = next.label;

    setTabLock(plannerTab, !plannerReady, "Grocery Planner, locked until a SNAP-authorized store is selected", "Grocery Planner");
    setTabLock(mealTab, !basketReady, "Meal Plan, locked until a grocery basket is created", "Meal Plan");
    setTabLock(budgetTab, !budgetReady, "Shopping Budget, locked until a grocery basket is created", "Shopping Budget");
  }

  window.NutriCartWorkflow = {
    get: () => ({
      locationReady: hasPlanningLocation(),
      storeReady: hasPlanningStore(),
      basketReady: hasCurrentBasket(),
      budgetReady: hasCurrentBasket() || budgetSessionReady,
    }),
  };

  function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function transitionDelay(full, subtle) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
    const mode = window.NutriCartSettings?.getSetting("transitions") || "full";
    return mode === "off" ? 0 : mode === "subtle" ? subtle : full;
  }

  async function switchView(name) {
    const views = {home: snapView, planner: plannerView, meal: mealView, budget: budgetView, snap: snapView};
    const tabs = {planner: plannerTab, meal: mealTab, budget: budgetTab, snap: snapTab};
    const nextView = views[name];
    if (viewTransitioning) return;
    updateWorkflowState();
    document.querySelector("#home").hidden = name !== "home";
    document.querySelector(".locator").hidden = name === "home";
    snapView.setAttribute("aria-labelledby", name === "home" ? "planner-title" : "snap-tab locator-title");
    if (name === "home") document.querySelector("#home-button").setAttribute("aria-current", "page");
    else document.querySelector("#home-button").removeAttribute("aria-current");
    Object.entries(tabs).forEach(([viewName, tab]) => {
      const selected = viewName === name;
      tab.classList.toggle("is-selected", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = name === "home" || selected ? 0 : -1;
    });

    if (nextView === activeView) return;
    viewTransitioning = true;
    activeView.classList.add("is-leaving");
    await wait(transitionDelay(220, 80));
    activeView.hidden = true;
    activeView.classList.remove("is-leaving");
    nextView.hidden = false;
    nextView.classList.add("is-entering", "reveal-sequence");
    requestAnimationFrame(() => nextView.classList.remove("is-entering"));
    nextView.focus({preventScroll: true});
    activeView = nextView;
    if (name === "snap") updateSnapPlanContext();
    if (name === "budget") {
      document.dispatchEvent(new CustomEvent("nutricart:budget-opened", {detail: {
        plannerBudget: currentPlan?.context?.budget ?? document.querySelector("#budget").value,
        plannedItems: currentResult?.groceries || [],
        context: currentPlan?.context || null,
      }}));
      updateWorkflowState();
    }
    await wait(transitionDelay(260, 90));
    nextView.classList.remove("reveal-sequence");
    viewTransitioning = false;
  }

  async function executeNextAction(action) {
    if (action === "meal") {
      await switchView("meal");
      document.dispatchEvent(new Event("nutricart:create-meal-plan"));
    } else if (action === "compare") {
      document.querySelector("#basket-comparison").hidden = false;
      document.querySelector("#compare-basket-prices").click();
      document.querySelector("#basket-comparison").scrollIntoView({behavior: "smooth", block: "start"});
    } else if (action === "budget") {
      await switchView("budget");
    } else if (action === "snap") {
      await switchView("snap");
    }
  }

  function updateSnapPlanContext() {
    const contextPanel = document.querySelector("#snap-plan-context");
    const hasPlan = Boolean(currentResult?.groceries?.length);
    contextPanel.hidden = !hasPlan;
    if (!hasPlan) return;
    const context = currentPlan?.context || reviewedInputs || {};
    const diet = labelFor(context.diet || "omnivore");
    document.querySelector("#snap-plan-summary").textContent = `${context.days || "Selected"} ${context.days === 1 ? "day" : "days"} · ${context.people || "Selected"} ${context.people === 1 ? "person" : "people"} · ${diet}`;
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "NutriCart could not complete that request.");
      error.details = data;
      throw error;
    }
    return data;
  }

  function selectedValue(name) {
    return form.querySelector(`input[name="${name}"]:checked`)?.value;
  }

  function numericValue(selector) {
    const input = document.querySelector(selector);
    return input.value.trim() === "" ? NaN : Number(input.value);
  }

  form.addEventListener("change", () => {
    const compatible = selectedValue("diet") === "pescatarian";
    document.querySelector("#include-fish-option").hidden = !compatible;
    if (!compatible) document.querySelector("#include-fish").checked = false;
  });

  function collectInputs() {
    const calories = numericValue("#calories");
    const protein = numericValue("#protein");
    const fiber = numericValue("#fiber-custom");
    return {
      location: window.NutriCartLocation?.get() || null,
      selected_store: window.NutriCartStore?.get() || null,
      include_fish: selectedValue("diet") === "pescatarian" && document.querySelector("#include-fish").checked,
      budget: numericValue("#budget"),
      people: numericValue("#people"),
      days: numericValue("#days"),
      diet: selectedValue("diet"),
      preference: selectedValue("preference"),
      food_group_exclusions: [...form.querySelectorAll('input[name="food_group_exclusions"]:checked')].map(input => input.value),
      nutrition_focus: document.querySelector("#nutrition-focus").value,
      foods_to_avoid: document.querySelector("#foods-to-avoid").value.split(",").map(item => item.trim()).filter(Boolean),
      calories: Number.isFinite(calories) ? calories : GENERAL_NUTRITION_TARGETS.calories,
      protein: Number.isFinite(protein) ? protein : GENERAL_NUTRITION_TARGETS.protein,
      fiber_mode: Number.isFinite(fiber) ? "custom" : "recommended",
      fiber_custom: Number.isFinite(fiber) ? fiber : null,
    };
  }

  function feasibilityPayload() {
    const calories = numericValue("#calories");
    const protein = numericValue("#protein");
    const fiber = numericValue("#fiber-custom");
    const manuallyCustomized = [calories, protein, fiber].some(Number.isFinite);
    return {
      location: window.NutriCartLocation?.get() || null,
      selected_store: window.NutriCartStore?.get() || null,
      include_fish: selectedValue("diet") === "pescatarian" && document.querySelector("#include-fish").checked,
      budget: Number.isFinite(numericValue("#budget")) ? numericValue("#budget") : null,
      people: Number.isInteger(numericValue("#people")) ? numericValue("#people") : null,
      days: Number.isInteger(numericValue("#days")) ? numericValue("#days") : null,
      diet: selectedValue("diet") || null,
      preference: selectedValue("preference") || "balanced",
      food_group_exclusions: [...form.querySelectorAll('input[name="food_group_exclusions"]:checked')].map(input => input.value),
      nutrition_focus: document.querySelector("#nutrition-focus").value,
      foods_to_avoid: document.querySelector("#foods-to-avoid").value.split(",").map(item => item.trim()).filter(Boolean),
      calories: Number.isFinite(calories) ? calories : null,
      protein: Number.isFinite(protein) ? protein : null,
      fiber_custom: Number.isFinite(fiber) ? fiber : null,
      nutrition_basis: suggestedTargetsApplied ? "household" : manuallyCustomized ? "manual" : "general",
    };
  }

  function resetFeasibilityGuidance() {
    feasibilityElements.budget.textContent = "Enter people, days, and diet to estimate the minimum budget.";
    feasibilityElements.people.textContent = "Enter budget, days, and diet to estimate household capacity.";
    feasibilityElements.days.textContent = "Enter budget, people, and diet to estimate the planning period.";
    [feasibilityElements.budget, feasibilityElements.people, feasibilityElements.days].forEach(element => element.classList.remove("is-calculated"));
    feasibilityElements.status.textContent = "";
    feasibilityElements.status.classList.remove("is-infeasible");
    submitButton.disabled = false;
    currentFeasibility = null;
  }

  function renderFeasibility(data, key) {
    const guidance = data.guidance || {};
    const inputs = JSON.parse(key);
    if (Number.isFinite(guidance.budget)) {
      feasibilityElements.budget.textContent = `Estimated minimum for this household and period: ${money(guidance.budget)}`;
      feasibilityElements.budget.classList.add("is-calculated");
    } else if (inputs.people !== null && inputs.days !== null) {
      feasibilityElements.budget.textContent = "No estimated minimum is available for the current catalog and selections.";
    }
    if (Number.isInteger(guidance.people) && guidance.people > 0) {
      feasibilityElements.people.textContent = `Estimated feasible range: 1–${guidance.people} people`;
      feasibilityElements.people.classList.add("is-calculated");
    } else if (inputs.budget !== null && inputs.days !== null) {
      feasibilityElements.people.textContent = "No feasible household range was found for the current catalog and selections.";
    }
    if (Number.isInteger(guidance.days) && guidance.days > 0) {
      feasibilityElements.days.textContent = `Estimated feasible range: 1–${guidance.days} days`;
      feasibilityElements.days.classList.add("is-calculated");
    } else if (inputs.budget !== null && inputs.people !== null) {
      feasibilityElements.days.textContent = "No feasible planning period was found for the current catalog and selections.";
    }
    const infeasible = data.status === "clearly_infeasible";
    feasibilityElements.status.textContent = data.status === "potentially_feasible" ? "" : data.message || "";
    feasibilityElements.status.classList.toggle("is-infeasible", infeasible);
    submitButton.disabled = infeasible;
    currentFeasibility = {key, ...data};
  }

  function scheduleFeasibility() {
    window.clearTimeout(feasibilityTimer);
    feasibilityController?.abort();
    feasibilityRequest += 1;
    resetFeasibilityGuidance();
    const payload = feasibilityPayload();
    const primaryCount = [payload.budget, payload.people, payload.days].filter(value => value !== null).length;
    if (!payload.diet || primaryCount < 2) return;
    const key = JSON.stringify(payload);
    const cached = feasibilityCache.get(key);
    if (cached) {
      renderFeasibility(cached, key);
      return;
    }
    const requestId = feasibilityRequest;
    feasibilityTimer = window.setTimeout(async () => {
      feasibilityController = new AbortController();
      try {
        const data = await requestJson("/api/grocery-feasibility", {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify(payload), signal: feasibilityController.signal,
        });
        if (requestId !== feasibilityRequest || key !== JSON.stringify(feasibilityPayload())) return;
        feasibilityCache.set(key, data);
        if (feasibilityCache.size > 30) feasibilityCache.delete(feasibilityCache.keys().next().value);
        renderFeasibility(data, key);
      } catch (error) {
        if (error.name !== "AbortError" && requestId === feasibilityRequest) resetFeasibilityGuidance();
      }
    }, 500);
  }

  function validateInputs(values) {
    const errors = [];
    if (!Number.isFinite(values.budget) || values.budget < 10) errors.push("Budget must be at least $10.");
    const peopleInvalid = !Number.isInteger(values.people) || values.people < 1 || values.people > 20;
    const daysInvalid = !Number.isInteger(values.days) || values.days < 1 || values.days > 31;
    if (peopleInvalid && daysInvalid) errors.push("NutriCart supports plans for 1–20 people and 1–31 days.");
    else if (peopleInvalid) errors.push("NutriCart supports plans for 1–20 people.");
    else if (daysInvalid) errors.push("NutriCart supports plans for 1–31 days.");
    if (!["omnivore", "vegetarian", "vegan", "pescatarian"].includes(values.diet)) errors.push("Choose a diet before generating your plan.");
    if (!Number.isFinite(values.calories) || values.calories < 500 || values.calories > 5000) errors.push(values.calories === 180 ? "Did you mean 1800 calories?" : "Daily calories must be from 500 to 5000.");
    if (!Number.isFinite(values.protein) || values.protein < 10 || values.protein > 300) errors.push("Daily protein must be from 10 to 300 grams.");
    if (values.fiber_mode === "custom" && (!Number.isFinite(values.fiber_custom) || values.fiber_custom < 5 || values.fiber_custom > 100)) errors.push("Custom fiber must be from 5 to 100 grams per day.");
    return errors;
  }

  const requiredPlannerFields = [
    {name: "budget", control: budgetInput, scrollTarget: budgetInput.closest("label"), error: document.querySelector("#budget-validation")},
    {name: "people", control: peopleInput, scrollTarget: peopleInput.closest("label"), error: document.querySelector("#people-validation")},
    {name: "days", control: daysInput, scrollTarget: daysInput.closest("label"), error: document.querySelector("#days-validation")},
    {name: "diet", control: dietInputs[0], controls: dietInputs, scrollTarget: dietOptions, error: document.querySelector("#diet-validation")},
  ];
  const requiredPlannerMessages = new Set([
    "Budget must be at least $10.",
    "NutriCart supports plans for 1–20 people and 1–31 days.",
    "NutriCart supports plans for 1–20 people.",
    "NutriCart supports plans for 1–31 days.",
    "Choose a diet before generating your plan.",
  ]);

  function requiredPlannerMessage(name, values) {
    if (name === "budget") {
      if (!budgetInput.value.trim()) return "Enter your grocery budget.";
      return !Number.isFinite(values.budget) || values.budget < 10 ? "Budget must be at least $10." : "";
    }
    if (name === "people") {
      if (!peopleInput.value.trim()) return "Enter the number of people.";
      return !Number.isInteger(values.people) || values.people < 1 || values.people > 20 ? "NutriCart supports plans for 1–20 people." : "";
    }
    if (name === "days") {
      if (!daysInput.value.trim()) return "Enter the number of shopping days.";
      return !Number.isInteger(values.days) || values.days < 1 || values.days > 31 ? "NutriCart supports plans for 1–31 days." : "";
    }
    return ["omnivore", "vegetarian", "vegan", "pescatarian"].includes(values.diet) ? "" : "Choose a dietary preference.";
  }

  function setRequiredPlannerState(field, message) {
    const invalid = Boolean(message);
    field.error.textContent = message;
    field.error.hidden = !invalid;
    field.scrollTarget.classList.toggle("is-invalid", invalid);
    field.scrollTarget.setAttribute("aria-invalid", String(invalid));
    (field.controls || [field.control]).forEach(control => control.setAttribute("aria-invalid", String(invalid)));
  }

  function validateRequiredPlannerFields(values, focusFirst = false) {
    let firstInvalid = null;
    requiredPlannerFields.forEach(field => {
      const message = requiredPlannerMessage(field.name, values);
      setRequiredPlannerState(field, message);
      if (message && !firstInvalid) firstInvalid = field;
    });
    if (focusFirst && firstInvalid) {
      firstInvalid.scrollTarget.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
        block: "center",
      });
      firstInvalid.control.focus({preventScroll: true});
    }
    return Boolean(firstInvalid);
  }

  function refreshRequiredPlannerField(field) {
    if (field.scrollTarget.getAttribute("aria-invalid") !== "true") return;
    setRequiredPlannerState(field, requiredPlannerMessage(field.name, collectInputs()));
  }

  function labelFor(value) {
    const labels = {omnivore: "Omnivore", vegetarian: "Vegetarian", vegan: "Vegan", pescatarian: "Pescatarian", balanced: "Balanced", budget: "Lowest Cost", nutrition: "Nutrition", variety: "Variety", none: "No Special Focus", lower_fat: "Lower Fat", high_protein: "High Protein", high_fiber: "High Fiber", lower_sodium: "Lower Sodium", dairy: "Dairy-Free", eggs: "Egg-Free", seafood: "No Seafood", nuts: "Nut-Free", gluten: "Gluten-Free"};
    return labels[value] || value;
  }

  function addDefinition(term, value) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    reviewDetails.append(dt, dd);
  }

  function renderReview(values) {
    stopGeneration();
    reviewDetails.replaceChildren();
    addDefinition("Budget", `$${values.budget.toFixed(2)}`);
    addDefinition("People", String(values.people));
    addDefinition("Days", String(values.days));
    addDefinition("Diet", labelFor(values.diet));
    if (values.include_fish) addDefinition("Fish", "Include fish");
    addDefinition("Plan Priority", labelFor(values.preference));
    addDefinition("Nutrition Focus", labelFor(values.nutrition_focus));
    addDefinition("Food Groups Excluded", values.food_group_exclusions.map(labelFor).join(", ") || "None");
    addDefinition("Other Foods to Avoid", values.foods_to_avoid.join(", ") || "None");
    addDefinition("Calories", `${values.calories} per day`);
    addDefinition("Protein", `${values.protein} g/day`);
    addDefinition("Fiber", values.fiber_mode === "custom" ? `${values.fiber_custom} g/day` : "General planning baseline");
    const enteredTargets = [caloriesInput, proteinInput, customFiberInput].filter(input => input.value.trim()).length;
    addDefinition("Nutrition target basis", suggestedTargetsApplied ? "Household-based suggested targets" : enteredTargets ? "Your entered values; general baseline for blanks" : "General planning baseline");
    form.hidden = true;
    resultsSection.hidden = true;
    reviewSection.hidden = false;
    reviewSection.scrollIntoView({behavior: "smooth", block: "start"});
  }

  function money(value) {
    return `$${Number(value || 0).toFixed(2)}`;
  }

  function packageDisplay(item) {
    const quantity = Number(item.quantity);
    const packageSize = typeof item.package_size === "string" ? item.package_size.trim() : "";
    if (packageSize) return `${quantity} × ${packageSize}`;
    return `Quantity: ${quantity}`;
  }

  function nutritionValue(source, names) {
    for (const name of names) if (source && source[name] != null) return Number(source[name]);
    return null;
  }

  function renderNutrition(result) {
    const actual = result.nutrition_per_person_per_day || {};
    const metrics = [
      ["Calories", ["calories_kcal", "calories"], "kcal"],
      ["Protein", ["protein_g", "protein"], "g"],
      ["Fiber", ["fiber_g", "fiber"], "g"],
    ];
    const container = document.querySelector("#nutrition-summary");
    const values = metrics.map(([label, keys, unit]) => {
      const actualValue = nutritionValue(actual, keys);
      return actualValue == null
        ? `${label} not available`
        : `${actualValue.toFixed(1)} ${unit}${label === "Calories" ? "" : ` ${label.toLowerCase()}`}`;
    });
    container.textContent = values.join(" · ");
    document.querySelector("#estimated-note").hidden = !(result.estimated_nutrition_count > 0);
  }

  function renderGroceries(groceries) {
    const container = document.querySelector("#grocery-list");
    container.replaceChildren();
    const groups = new Map();
    groceries.forEach(item => {
      const category = item.category || "Other";
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(item);
    });
    [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([category, items]) => {
      const section = document.createElement("section");
      section.className = "grocery-group";
      const heading = document.createElement("h4");
      heading.textContent = category;
      section.append(heading);
      items.forEach(item => {
        const card = document.createElement("article");
        card.className = "grocery-item";
        const name = document.createElement("strong");
        name.className = "grocery-item-name";
        name.textContent = item.product_name || "Unnamed product";
        const details = document.createElement("p");
        details.className = "grocery-item-meta";
        const packagePrice = typeof item.package_size === "string" && item.package_size.trim()
          ? `${money(item.unit_price)} per package`
          : `Unit price: ${money(item.unit_price)}`;
        details.textContent = `${packageDisplay(item)} · ${packagePrice}`;
        const total = document.createElement("b");
        total.className = "grocery-item-total";
        total.textContent = money(item.item_total);
        card.append(name, details, total);
        section.append(card);
      });
      container.append(section);
    });
  }

  function renderPriceSource(groceries) {
    const source = document.querySelector("#receipt-price-source");
    const stores = [...new Set((groceries || []).map(item => typeof item.store_name === "string" ? item.store_name.trim() : "").filter(Boolean))];
    source.textContent = stores.length ? `Observed price source${stores.length === 1 ? "" : "s"}: ${stores.join(", ")}` : "";
    source.hidden = stores.length === 0;
  }

  function renderScoreExplanation(explanation) {
    const container = document.querySelector("#score-components");
    container.replaceChildren();
    const components = explanation?.components || {};
    const rows = [
      ["Nutrition target alignment", components.nutrition_target_alignment],
      ["Product variety", components.product_variety],
      ["Category variety", components.category_variety],
    ];
    rows.forEach(([label, component]) => {
      if (!component) return;
      const row = document.createElement("div");
      row.className = "score-component";
      const name = document.createElement("strong");
      const detail = document.createElement("span");
      name.textContent = label;
      detail.textContent = `${Number(component.score).toFixed(1)} / 100 · ${component.weight_percent}% of score`;
      row.append(name, detail);
      container.append(row);
    });
  }

  function savedMealBasket(item) {
    const saved = item?.data;
    const context = saved?.context;
    const groceries = saved?.groceries;
    const summary = saved?.summary;
    const diets = new Set(["omnivore", "vegetarian", "vegan", "pescatarian"]);
    const priorities = new Set(["balanced", "budget", "nutrition", "variety"]);
    const validContext = context && Number.isFinite(Number(context.budget))
      && Number.isInteger(Number(context.people)) && Number(context.people) > 0
      && Number.isInteger(Number(context.days)) && Number(context.days) > 0
      && diets.has(context.diet) && priorities.has(context.preference)
      && Number.isFinite(Number(context.calories)) && Number.isFinite(Number(context.protein))
      && ["recommended", "custom"].includes(context.fiber_mode)
      && context.targets && typeof context.targets === "object"
      && context.dailyNutrition && typeof context.dailyNutrition === "object";
    const validGroceries = Array.isArray(groceries) && groceries.length > 0 && groceries.every(grocery =>
      grocery && typeof grocery.product_id === "string" && grocery.product_id.trim()
      && typeof grocery.product_name === "string" && grocery.product_name.trim()
      && Number.isInteger(Number(grocery.quantity)) && Number(grocery.quantity) > 0
      && Number.isFinite(Number(grocery.unit_price)) && Number(grocery.unit_price) >= 0
      && Number.isFinite(Number(grocery.item_total)) && Number(grocery.item_total) >= 0
    );
    const total = Number(summary?.total);
    if (!validContext || !validGroceries || !Number.isFinite(total)) return null;
    const score = Number(summary?.score);
    const restoredContext = {
      ...context,
      people: Number(context.people), days: Number(context.days), budget: Number(context.budget),
      food_group_exclusions: Array.isArray(context.food_group_exclusions) ? [...context.food_group_exclusions] : [],
      foods_to_avoid: Array.isArray(context.foods_to_avoid) ? [...context.foods_to_avoid] : [],
      targets: {...context.targets}, dailyNutrition: {...context.dailyNutrition},
    };
    return {
      context: restoredContext,
      result: {
        solver_status: "Saved",
        groceries: groceries.map(grocery => ({...grocery})),
        total_cost: total,
        remaining_budget: Number((restoredContext.budget - total).toFixed(2)),
        nutrition_per_person_per_day: {...restoredContext.dailyNutrition},
        nutrition_targets: {...restoredContext.targets},
        quality_score: Number.isFinite(score) ? score : null,
        quality_score_explanation: null,
        planning_settings: {
          diet: restoredContext.diet,
          preference: restoredContext.preference,
          nutrition_focus: restoredContext.nutrition_focus || "none",
          food_group_exclusions: [...restoredContext.food_group_exclusions],
        },
        planning_context: restoredContext,
        estimated_nutrition_count: groceries.filter(grocery => grocery.nutrition_is_estimated).length,
        restored_from_saved_meal: true,
      },
    };
  }

  function selectedStoreName(context) {
    const name = context?.selected_store?.name;
    return typeof name === "string" ? name.trim() : "";
  }
  function renderResult(result, alternative = false, contextOverride = null) {
    stopGeneration();
    if (alternative && currentResult?.groceries?.length) {
      const previousIds = currentResult.groceries.map(item => item.product_id).filter(Boolean);
      if (previousIds.length) alternativeHistory.push(previousIds);
      alternativeHistory = alternativeHistory.slice(-6);
    } else if (!alternative) {
      alternativeHistory = [];
    }
    const context = {...(contextOverride || result.planning_context || reviewedInputs || {})};
    if (!contextOverride) context.selected_store = reviewedInputs?.selected_store || null;
    const storeLabel = selectedStoreName(context);
    const budget = Number(context.budget);
    const total = Number(result.total_cost || 0);
    currentResult = {...result, remaining_budget: Number.isFinite(budget) ? Number((budget - total).toFixed(2)) : result.remaining_budget};
    currentPlan = {context, result: currentResult};
    reviewedInputs = {...context};
    document.dispatchEvent(new CustomEvent("nutricart:plan-updated", {detail: {
      plannedItems: currentResult.groceries || [],
      result: {...currentResult},
      context: {...context, targets: currentResult.nutrition_targets || {}, dailyNutrition: currentResult.nutrition_per_person_per_day || {}},
    }}));
    document.querySelector("#plan-results-title").textContent = "Your Grocery Basket";
    const successful = ["optimal", "feasible"].includes(String(result.solver_status || "").toLowerCase());
    const difference = alternative ? Number(result.alternative_difference_count || 0) : 0;
    document.querySelector("#solver-status").textContent = successful
      ? (alternative ? `This alternative is now your current plan. ${difference} grocery type${difference === 1 ? "" : "s"} changed.` : "")
      : "Plan generation needs attention.";
    document.querySelector("#total-cost").textContent = money(result.total_cost);
    document.querySelector("#receipt-budget").textContent = money(budget);
    document.querySelector("#remaining-budget").textContent = money(currentResult.remaining_budget);
    document.querySelector("#plan-score").textContent = result.quality_score != null && Number.isFinite(Number(result.quality_score))
      ? `${Number(result.quality_score).toFixed(1)} / 100`
      : "Not available";
    const settings = result.planning_settings || {};
    document.querySelector("#receipt-context").textContent = [storeLabel, `${money(budget)} budget`, `${context.people} ${Number(context.people) === 1 ? "person" : "people"}`, `${context.days} ${Number(context.days) === 1 ? "day" : "days"}`, labelFor(settings.diet || context.diet)].filter(Boolean).join(" \u00b7 ");
    const preferenceDetails = [];
    if ((settings.nutrition_focus || "none") !== "none") preferenceDetails.push(labelFor(settings.nutrition_focus));
    const avoided = [...(settings.food_group_exclusions || []).map(labelFor), ...(context.foods_to_avoid || [])];
    if (avoided.length) preferenceDetails.push(`Avoiding: ${avoided.join(", ")}`);
    const settingsSummary = document.querySelector("#result-settings");
    settingsSummary.textContent = preferenceDetails.join(" · ");
    settingsSummary.hidden = !preferenceDetails.length;
    renderScoreExplanation(result.quality_score_explanation);
    const hasScoreExplanation = Boolean(result.quality_score_explanation?.components);
    document.querySelector("#score-explanation-toggle").hidden = !hasScoreExplanation;
    document.querySelector("#score-explanation").hidden = true;
    renderGroceries(result.groceries || []);
    renderPriceSource(result.groceries || []);
    if (context.catalog_scope?.mode === "general") {
      const source = document.querySelector("#receipt-price-source");
      source.textContent = context.catalog_scope.price_basis;
      source.hidden = false;
    }
    renderNutrition(result);
    document.querySelector("#basket-comparison").hidden = true;
    planError.textContent = result.solver_status === "Infeasible" ? "NutriCart could not find a plan for these constraints. Edit your details and try again." : "";
    form.hidden = true;
    reviewSection.hidden = true;
    resultsSection.hidden = false;
    resultsSection.scrollIntoView({behavior: "smooth", block: "start"});
  }

  function formatPlanForCopy() {
    if (!currentPlan?.result?.groceries?.length) return "";
    const {context} = currentPlan;
    const settings = currentResult.planning_settings || {};
    const lines = [
      "NutriCart Grocery Basket", "",
      `Budget: ${money(context.budget)}`,
      `Household: ${context.people} ${context.people === 1 ? "person" : "people"}`,
      `Days: ${context.days}`,
      `Diet: ${labelFor(settings.diet || context.diet)}`,
      `Nutrition Focus: ${labelFor(settings.nutrition_focus || context.nutrition_focus || "none")}`,
    ];
    const planLocation = [context.location?.locality, context.location?.region].filter(Boolean).join(", ");
    if (planLocation) lines.push(`Plan location: ${planLocation}`);
    if (context.catalog_scope?.mode === "general") lines.push(context.catalog_scope.price_basis);
    const exclusions = (settings.food_group_exclusions || context.food_group_exclusions || []).map(labelFor);
    if (exclusions.length) lines.push(`Exclusions: ${exclusions.join(", ")}`);
    if (context.foods_to_avoid?.length) lines.push(`Foods to Avoid: ${context.foods_to_avoid.join(", ")}`);
    lines.push("", `Total Cost: ${money(currentResult.total_cost)}`, `Remaining Budget: ${money(currentResult.remaining_budget)}`,
      `Plan Score: ${Number(currentResult.quality_score || 0).toFixed(1)} / 100`, "", "Your Grocery Basket", "");
    const groups = new Map();
    currentResult.groceries.forEach(item => {
      const category = item.category || "Other";
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(item);
    });
    [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([category, items]) => {
      lines.push(category);
      items.forEach(item => lines.push(`- ${item.product_name || "Unnamed product"} — ${packageDisplay(item)} — ${money(item.item_total)}`));
      lines.push("");
    });
    const nutrition = currentResult.nutrition_per_person_per_day || {};
    lines.push("Nutrition per person per day",
      `Calories: ${Number(nutrition.calories_kcal || 0).toFixed(1)} kcal`,
      `Protein: ${Number(nutrition.protein_g || 0).toFixed(1)} g`,
      `Fiber: ${Number(nutrition.fiber_g || 0).toFixed(1)} g`);
    return lines.join("\n").trim();
  }

  function fallbackCopy(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text; textarea.setAttribute("readonly", ""); textarea.className = "copy-helper";
    document.body.append(textarea); textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove(); return copied;
  }

  async function copyCurrentPlan() {
    const button = document.querySelector("#copy-grocery-plan");
    const status = document.querySelector("#copy-plan-status");
    const text = formatPlanForCopy();
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else if (!fallbackCopy(text)) throw new Error("Copy unavailable");
      button.textContent = "Copied!"; status.textContent = "Grocery plan copied to clipboard.";
      window.setTimeout(() => { button.textContent = "Copy Plan"; }, 1800);
    } catch (error) {
      status.textContent = "The grocery plan could not be copied. Please try again.";
    }
  }

  function setLoaderProgress(value) {
    const percent = Math.round(value);
    // Reduced motion uses discrete updates; the bag is always static.
    const displayed = transitionDelay(1, 0) ? value : percent;
    groceryLoaderFill.style.transform = `scaleX(${displayed / 100})`;
    if (groceryLoaderProgress.getAttribute("aria-valuenow") !== String(percent)) {
      groceryLoaderProgress.setAttribute("aria-valuenow", String(percent));
      groceryLoaderPercent.textContent = `${percent}%`;
    }
  }

  function startLoaderProgress(request) {
    request.progress = 8;
    setLoaderProgress(request.progress);
    const advance = () => {
      if (activeGeneration !== request) return;
      // Perceived progress is elapsed-time based, never optimizer telemetry.
      const elapsed = performance.now() - request.startedAt;
      request.progress = Math.min(94, 94 - 86 * Math.exp(-elapsed / 12000));
      setLoaderProgress(request.progress);
      request.progressFrame = requestAnimationFrame(advance);
    };
    request.progressFrame = requestAnimationFrame(advance);
  }

  function completeLoaderProgress(request) {
    if (activeGeneration !== request) return Promise.resolve();
    cancelAnimationFrame(request.progressFrame);
    const started = performance.now();
    const duration = transitionDelay(240, 120);
    return new Promise(resolve => {
      request.progressDone = resolve;
      const complete = () => {
        if (activeGeneration !== request) return;
        const fraction = duration ? Math.min(1, (performance.now() - started) / duration) : 1;
        setLoaderProgress(request.progress + (100 - request.progress) * fraction);
        if (fraction < 1) request.progressFrame = requestAnimationFrame(complete);
        else request.progressTimer = window.setTimeout(() => {
          request.progressDone = null;
          resolve();
        }, 120);
      };
      complete();
    });
  }

  function stopGeneration() {
    if (!activeGeneration) return;
    const request = activeGeneration;
    activeGeneration = null;
    cancelAnimationFrame(request.progressFrame);
    window.clearTimeout(request.progressTimer);
    request.progressDone?.();
    request.controller.abort();
    request.button.disabled = false;
    form.hidden = request.visibility.form;
    reviewSection.hidden = request.visibility.review;
    resultsSection.hidden = request.visibility.results;
    groceryLoader.hidden = true;
    groceryLoaderStatus.textContent = "";
    setLoaderProgress(0);
  }

  async function generate(alternative = false, triggerButton = null) {
    stopGeneration();
    const location = window.NutriCartLocation?.get();
    if (!hasPlanningLocation() || !hasPlanningStore()) { updatePlanningLocation(); switchView("snap"); return; }
    if (alternative && JSON.stringify(currentPlan?.context?.location) !== JSON.stringify(location)) {
      editPlan();
      plannerError.textContent = "Build a new basket for your selected location.";
      return;
    }
    const button = triggerButton || (alternative ? alternativeButton : generateButton);
    const errorOutput = alternative ? planError : form.hidden ? generateStatus : plannerError;
    const request = {
      controller: new AbortController(), button, startedAt: performance.now(),
      visibility: {form: form.hidden, review: reviewSection.hidden, results: resultsSection.hidden},
    };
    activeGeneration = request;
    button.disabled = true;
    plannerStatus.textContent = "";
    generateStatus.textContent = "";
    plannerError.textContent = "";
    planError.textContent = "";
    form.hidden = true;
    reviewSection.hidden = true;
    resultsSection.hidden = true;
    groceryLoader.hidden = false;
    groceryLoaderStatus.textContent = "Building your grocery plan…";
    startLoaderProgress(request);
    groceryLoader.scrollIntoView({behavior: "instant", block: "center"});
    let result;
    try {
      const payload = {...reviewedInputs, location};
      if (alternative) {
        payload.excluded_product_ids = (currentResult?.groceries || []).map(item => item.product_id).filter(Boolean);
        payload.previous_product_id_sets = alternativeHistory;
      }
      result = await requestJson(alternative ? "/api/grocery-plan/alternative" : "/api/grocery-plan", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload), signal: request.controller.signal});
      if (activeGeneration !== request) return;
      const remaining = 600 - (performance.now() - request.startedAt);
      if (remaining > 0) await wait(remaining);
      await completeLoaderProgress(request);
      if (activeGeneration !== request) return;
    } catch (error) {
      if (activeGeneration !== request) return;
      stopGeneration();
      if (error.name === "AbortError") return;
      const message = error.details?.suggested_calories === 1800 ? "Did you mean 1800 calories?" : error.message;
      errorOutput.textContent = error.name === "TypeError" ? "NutriCart could not complete that request. Please try again." : message;
      if (!plannerView.hidden) button.focus({preventScroll: true});
      return;
    } finally {
      if (activeGeneration === request) stopGeneration();
    }
    renderResult(result, alternative);
  }

  function editPlan() {
    stopGeneration();
    const context = currentPlan?.context || reviewedInputs;
    if (context) {
      const fields = {budget: context.budget, people: context.people, days: context.days};
      Object.entries(fields).forEach(([identifier, value]) => {
        if (value !== undefined && value !== null) document.querySelector(`#${identifier}`).value = String(value);
      });
      ["diet", "preference"].forEach(name => {
        const value = context[name];
        if (value) form.querySelector(`input[name="${name}"][value="${value}"]`)?.click();
      });
      const excluded = new Set(context.food_group_exclusions || []);
      form.querySelectorAll('input[name="food_group_exclusions"]').forEach(input => { input.checked = excluded.has(input.value); });
      document.querySelector("#include-fish").checked = context.diet === "pescatarian" && context.include_fish === true;
      document.querySelector("#nutrition-focus").value = context.nutrition_focus || "none";
      document.querySelector("#foods-to-avoid").value = (context.foods_to_avoid || []).join(", ");
    }
    syncHouseholdToPeople(numericValue("#people"), true);
    reviewSection.hidden = true;
    resultsSection.hidden = true;
    form.hidden = !hasPlanningLocation();
    plannerError.textContent = "";
    plannerStatus.textContent = "";
    scheduleFeasibility();
    form.scrollIntoView({behavior: "smooth", block: "start"});
  }

  document.querySelector("#home-button").addEventListener("click", async () => {
    if (viewTransitioning) return;
    await switchView("home");
    document.querySelector("#planner-title").focus({preventScroll: true});
    document.querySelector("#home").scrollIntoView({behavior: "instant", block: "start"});
  });
  document.querySelector("#footer-home").addEventListener("click", () => document.querySelector("#home-button").click());
  plannerTab.addEventListener("click", () => switchView("planner"));
  window.addEventListener("pagehide", stopGeneration);
  mealTab.addEventListener("click", () => switchView("meal"));
  budgetTab.addEventListener("click", () => switchView("budget"));
  snapTab.addEventListener("click", () => switchView("snap"));
  document.querySelector("#hero-find-snap").addEventListener("click", async () => {
    await switchView("snap");
    document.querySelector("#location-button").focus({preventScroll: true});
    document.querySelector(".locator").scrollIntoView({behavior: transitionDelay(1, 1) ? "smooth" : "instant", block: "start"});
  });
  document.querySelector("#set-planning-location").addEventListener("click", () => switchView("snap"));
  document.querySelector("#change-planning-location").addEventListener("click", () => switchView("snap"));
  function updatePlanningLocation() {
    updateWorkflowState();
  }
  function invalidateCurrentPlanForLocation() {
    const hadPlan = hasCurrentBasket();
    currentResult = null;
    currentPlan = null;
    reviewedInputs = null;
    alternativeHistory = [];
    budgetSessionReady = false;
    resultsSection.hidden = true;
    reviewSection.hidden = true;
    if (hadPlan) document.dispatchEvent(new CustomEvent("nutricart:plan-updated", {detail: {plannedItems: [], context: {}}}));
    updateSnapPlanContext();
    updateWorkflowState();
  }
  document.addEventListener("nutricart:location-changing", () => {
    stopGeneration();
    invalidateCurrentPlanForLocation();
  });
  document.addEventListener("nutricart:location-changed", () => {
    stopGeneration();
    if (hasCurrentBasket()) invalidateCurrentPlanForLocation();
    else updateWorkflowState();
    scheduleFeasibility();
  });
  updatePlanningLocation();
  document.querySelector("#footer-settings")?.addEventListener("click", () => document.querySelector("#settings-button")?.click());
  document.querySelector(".view-tabs")?.addEventListener("keydown", event => {
    const tabs = [snapTab, plannerTab, mealTab, budgetTab];
    const index = tabs.indexOf(event.target);
    if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
      (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIndex].focus();
    tabs[nextIndex].click();
  });
  document.addEventListener("nutricart:navigate", event => {
    if (["planner", "meal", "budget", "snap"].includes(event.detail?.view)) switchView(event.detail.view);
  });
  document.addEventListener("nutricart:store-changed", () => {
    if (hasCurrentBasket()) invalidateCurrentPlanForLocation();
    else updateWorkflowState();
  });
  document.addEventListener("nutricart:plan-updated", updateWorkflowState);
  document.addEventListener("nutricart:open-saved-shopping", event => {
    const saved = event.detail?.data;
    budgetSessionReady = Boolean(saved && ((saved.shoppingItems || []).length || (saved.purchases || []).length));
    updateWorkflowState();
  });
  document.addEventListener("nutricart:open-saved-plan", event => {
    const saved = event.detail?.data;
    if (!saved?.result || !saved?.context) return;
    renderResult(saved.result, false, saved.context);
    const solverStatus = document.querySelector("#solver-status");
    if (solverStatus) {
      solverStatus.textContent = `Saved plan opened · Saved ${new Date(event.detail.updated_at).toLocaleDateString()}`;
    }
    switchView("planner");
  });
  document.addEventListener("nutricart:restore-saved-meal-basket", event => {
    const detail = event.detail || {};
    const restored = savedMealBasket(detail.item);
    if (!restored) {
      detail.restored = false;
      detail.error = "This saved Meal Plan does not include enough associated grocery information to restore safely. Your current plan was not changed.";
      return;
    }
    renderResult(restored.result, false, restored.context);
    document.querySelector("#solver-status").textContent = "Associated grocery basket restored from your saved Meal Plan.";
    detail.restored = true;
  });
  document.querySelector("#snap-back-to-plan")?.addEventListener("click", () => switchView("planner"));
  document.querySelector("#snap-open-meal")?.addEventListener("click", () => switchView("meal"));
  document.querySelector("#snap-open-budget")?.addEventListener("click", () => switchView("budget"));
  budgetLockedAction.addEventListener("click", () => switchView(budgetLockedAction.dataset.workflowTarget || "snap"));
  document.querySelectorAll("[data-next-action]").forEach(button => {
    button.addEventListener("click", async () => {
      if (viewTransitioning || button.disabled) return;
      button.disabled = true;
      try { await executeNextAction(button.dataset.nextAction); }
      finally { button.disabled = false; }
    });
  });
  const householdEstimator = document.querySelector("#household-estimator");
  const householdMembers = document.querySelector("#household-members");
  const estimateStatus = document.querySelector("#household-estimate-status");
  const estimateResult = document.querySelector("#household-estimate-result");
  const targetInputs = new Map([
    ["calories", caloriesInput], ["protein", proteinInput], ["fiber", customFiberInput],
  ]);
  const householdDerivedTargets = new Set();
  let householdEstimatePeople = null;
  let householdEstimateRequest = 0;

  function memberRow(index) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "household-member";
    const legend = document.createElement("legend");
    legend.textContent = `Person ${index + 1}`;
    fieldset.append(legend);
    fieldset.insertAdjacentHTML("beforeend", `<div class="household-member-fields"><label>Age<input data-member-age type="number" min="2" max="120" step="1" inputmode="numeric" required></label><label>Reference category<select data-member-category required><option value="">Choose</option><option value="female">Female reference</option><option value="male">Male reference</option></select></label><label>Activity reference<select data-member-activity required><option value="">Not sure</option><option value="sedentary">Sedentary</option><option value="moderate">Moderately active</option><option value="active">Active</option></select></label><label>Special life stage<select data-member-stage><option value="none">None</option><option value="pregnant">Pregnancy</option><option value="lactating">Lactation</option><option value="medical">Medical nutrition needs</option></select></label></div>`);
    return fieldset;
  }

  function invalidateHouseholdEstimate(message = "") {
    householdEstimateRequest += 1;
    householdDerivedTargets.forEach(key => { targetInputs.get(key).value = ""; });
    householdDerivedTargets.clear();
    householdEstimatePeople = null;
    suggestedTargetsApplied = false;
    estimateResult.hidden = true;
    if (message) estimateStatus.textContent = message;
  }

  function resizeHouseholdRows(people) {
    let rows = [...householdMembers.querySelectorAll(".household-member")];
    while (rows.length > people) rows.pop().remove();
    while (rows.length < people) {
      householdMembers.append(memberRow(rows.length));
      rows = [...householdMembers.querySelectorAll(".household-member")];
    }
    rows.forEach((row, index) => { row.querySelector("legend").textContent = `Person ${index + 1}`; });
  }

  function syncHouseholdToPeople(people, announce = false) {
    if (!Number.isInteger(people) || people < 1 || people > 20) return false;
    const rowCount = householdMembers.querySelectorAll(".household-member").length;
    const rowsNeedResize = !householdEstimator.hidden && rowCount !== people;
    const estimateIsStale = householdEstimatePeople !== null && householdEstimatePeople !== people;
    if (estimateIsStale) {
      invalidateHouseholdEstimate(announce ? "Household size changed. Recalculate suggested nutrition targets." : "");
    } else if (rowsNeedResize) {
      householdEstimateRequest += 1;
      estimateResult.hidden = true;
    }
    if (rowsNeedResize) resizeHouseholdRows(people);
    return true;
  }

  targetInputs.forEach((input, key) => input.addEventListener("input", () => {
    householdDerivedTargets.delete(key);
    suggestedTargetsApplied = false;
  }));
  form.querySelectorAll('#budget, #people, #days, #foods-to-avoid, #calories, #protein, #fiber-custom').forEach(input => input.addEventListener("input", scheduleFeasibility));
  form.querySelectorAll('input[name="diet"], input[name="preference"], input[name="food_group_exclusions"], #nutrition-focus').forEach(input => input.addEventListener("change", scheduleFeasibility));
  peopleInput.addEventListener("input", () => {
    const people = numericValue("#people");
    if (Number.isInteger(people)) syncHouseholdToPeople(people, true);
  });
  const householdValidationMessages = [
    "NutriCart supports plans for 1–20 people and 1–31 days.",
    "NutriCart supports plans for 1–20 people.",
    "NutriCart supports plans for 1–31 days.",
  ];
  function refreshVisibleHouseholdValidation() {
    if (!householdValidationMessages.some(message => plannerError.textContent.includes(message))) return;
    plannerError.textContent = validateInputs(collectInputs()).join(" ");
  }
  peopleInput.addEventListener("input", refreshVisibleHouseholdValidation);
  daysInput.addEventListener("input", refreshVisibleHouseholdValidation);
  requiredPlannerFields.forEach(field => {
    const eventName = field.name === "diet" ? "change" : "input";
    (field.controls || [field.control]).forEach(control => control.addEventListener(eventName, () => refreshRequiredPlannerField(field)));
  });

  document.querySelector("#use-suggested-targets").addEventListener("click", () => {
    const people = numericValue("#people");
    if (!Number.isInteger(people) || people < 1 || people > 20) {
      plannerError.textContent = "Enter People (1 to 20) before using suggested targets.";
      document.querySelector("#people").focus();
      return;
    }
    householdEstimator.hidden = false;
    syncHouseholdToPeople(people, true);
    resizeHouseholdRows(people);
    estimateStatus.textContent = "";
    estimateResult.hidden = true;
    document.querySelector("#use-suggested-targets").setAttribute("aria-expanded", "true");
    householdMembers.querySelector("input")?.focus();
  });

  document.querySelector("#calculate-household-targets").addEventListener("click", async () => {
    const people = numericValue("#people");
    if (!syncHouseholdToPeople(people, true)) {
      estimateStatus.textContent = "Enter People (1 to 20) before calculating suggested targets.";
      peopleInput.focus();
      return;
    }
    const rows = [...householdMembers.querySelectorAll(".household-member")];
    if (rows.length !== people) {
      resizeHouseholdRows(people);
      estimateStatus.textContent = "Household size changed. Complete the updated household rows, then calculate again.";
      return;
    }
    const members = rows.map(row => ({
      age: Number(row.querySelector("[data-member-age]").value),
      reference_category: row.querySelector("[data-member-category]").value,
      activity: row.querySelector("[data-member-activity]").value,
      special_stage: row.querySelector("[data-member-stage]").value,
    }));
    estimateStatus.textContent = "Calculating household planning references...";
    const requestId = ++householdEstimateRequest;
    try {
      const data = await requestJson("/api/nutrition-reference", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({people, members})});
      if (requestId !== householdEstimateRequest || numericValue("#people") !== people || householdMembers.querySelectorAll(".household-member").length !== people) {
        estimateStatus.textContent = "Household size changed. Recalculate suggested nutrition targets.";
        return;
      }
      const average = data.per_person_daily;
      caloriesInput.value = String(average.calories_kcal);
      proteinInput.value = String(average.protein_g);
      customFiberInput.value = String(average.fiber_g);
      householdDerivedTargets.clear();
      targetInputs.forEach((_input, key) => householdDerivedTargets.add(key));
      householdEstimatePeople = people;
      suggestedTargetsApplied = true;
      const total = data.household_daily;
      estimateResult.textContent = `Suggested household daily reference: ${total.calories_kcal} kcal, ${total.protein_g} g protein, ${total.fiber_g} g fiber. Household average per person/day: ${average.calories_kcal} kcal, ${average.protein_g} g protein, ${average.fiber_g} g fiber.`;
      estimateResult.hidden = false;
      estimateStatus.textContent = "Suggested values added below. You can edit them.";
      scheduleFeasibility();
      caloriesInput.focus();
    } catch (error) {
      estimateResult.hidden = true;
      estimateStatus.textContent = error.message;
    }
  });
  function validatedInputs() {
    if (!window.NutriCartLocation?.get()) { switchView("snap"); return null; }
    syncHouseholdToPeople(numericValue("#people"), true);
    const values = collectInputs();
    const requiredInvalid = validateRequiredPlannerFields(values, true);
    const errors = validateInputs(values);
    const feasibilityKey = JSON.stringify(feasibilityPayload());
    if (currentFeasibility?.key === feasibilityKey && currentFeasibility.status === "clearly_infeasible") errors.push(currentFeasibility.message);
    plannerError.textContent = errors.filter(error => !requiredPlannerMessages.has(error)).join(" ");
    if (requiredInvalid || errors.length) return null;
    reviewedInputs = values;
    return values;
  }
  document.querySelector("#review-settings").addEventListener("click", () => {
    const values = validatedInputs();
    if (values) renderReview(values);
  });
  document.querySelector("#edit-review").addEventListener("click", editPlan);
  document.querySelector("#edit-plan").addEventListener("click", editPlan);
  document.querySelector("#copy-grocery-plan").addEventListener("click", copyCurrentPlan);
  generateButton.addEventListener("click", () => generate(false));
  alternativeButton.addEventListener("click", () => generate(true));
  document.querySelector("#score-explanation-toggle").addEventListener("click", event => {
    const explanation = document.querySelector("#score-explanation");
    explanation.hidden = !explanation.hidden;
    event.currentTarget.setAttribute("aria-expanded", String(!explanation.hidden));
  });
  const initialDiet = window.NutriCartSettings?.getSetting("defaultDiet") || "none";
  const initialPriority = window.NutriCartSettings?.getSetting("defaultPlanPriority") || "balanced";
  const initialFocus = window.NutriCartSettings?.getSetting("defaultNutritionFocus") || "none";
  document.querySelector(`input[name="diet"][value="${initialDiet}"]`)?.click();
  document.querySelector(`input[name="preference"][value="${initialPriority}"]`).checked = true;
  document.querySelector("#nutrition-focus").value = initialFocus;
  document.querySelector("#planner-options").open = window.NutriCartSettings?.getSetting("advancedPlannerDefault") === "expanded";
  [snapTab, plannerTab, mealTab, budgetTab].forEach(tab => { tab.tabIndex = tab === snapTab ? 0 : -1; });
  // Every visit starts at Home; saved preferences never select a workflow.
})();
