(() => {
  // Event contracts:
  //   Listens: 'nutricart:plan-updated', 'nutricart:create-meal-plan', 'nutricart:open-saved-meal'
  //   Dispatches: 'nutricart:meal-rendered', 'nutricart:navigate', 'nutricart:open-comparison'
  const empty = document.querySelector("#meal-plan-empty");
  if (!empty) return;
  const ready = document.querySelector("#meal-plan-ready");
  const results = document.querySelector("#meal-plan-results");
  const status = document.querySelector("#meal-plan-status");
  const createButton = document.querySelector("#create-meal-plan");
  const daysOutput = document.querySelector("#meal-days");
  const basketNutritionOutput = document.querySelector("#meal-basket-nutrition");
  let currentPlan = null;
  let hasRenderedPlan = false;
  let planVersion = 0;
  let currentPlanRevision = -1;
  let activeRequest = null;

  function setStatus(message, isError = false, announceOnly = false) {
    status.textContent = message;
    status.classList.toggle("error", isError);
    status.classList.toggle("sr-only", announceOnly);
    status.setAttribute("role", isError ? "alert" : "status");
    status.setAttribute("aria-live", isError ? "assertive" : "polite");
  }

  function navigate(view) {
    document.dispatchEvent(new CustomEvent("nutricart:navigate", {detail: {view}}));
  }

  function displayedDiet(value) {
    if (value === "omnivore") return "Non-Vegetarian";
    const normalized = String(value || "").replaceAll("_", " ");
    return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "";
  }

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }

  function nutritionSummary(nutrition, targets) {
    const list = node("dl", "basket-nutrition-grid");
    const rows = [
      ["Calories", "calories_kcal", "kcal", 0, targets.calories_kcal],
      ["Protein", "protein_g", "g", 1, targets.protein_g],
      ["Fiber", "fiber_g", "g", 1, targets.fiber_g],
      ["Fat", "fat_g", "g", 1, null],
      ["Sodium", "sodium_mg", "mg", 0, null],
    ];
    rows.forEach(([label, key, unit, decimals, target]) => {
      const cell = node("div", "basket-nutrient");
      const value = node("dd");
      const actual = nutrition[key];
      const formatted = typeof actual === "number" && Number.isFinite(actual)
        ? `${actual.toLocaleString(undefined, {maximumFractionDigits: decimals})} ${unit}`
        : "Unavailable";
      value.append(node("span", "basket-nutrient-value", formatted));
      if (typeof target === "number" && Number.isFinite(target) && target > 0) {
        value.append(node("small", "basket-nutrient-target", `Target: ${target.toLocaleString(undefined, {maximumFractionDigits: 1})} ${unit}`));
      }
      cell.append(node("dt", "", label), value);
      list.append(cell);
    });
    return list;
  }

  function renderMeal(meal) {
    const mealType = String(meal.meal_type || "meal");
    const article = node("article", `meal-card meal-card--${mealType.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
    article.append(node("span", "meal-type", mealType.charAt(0).toUpperCase() + mealType.slice(1)), node("h4", "", meal.title));
    const products = meal.products || [];
    const details = node("details", "meal-product-details");
    details.append(node("summary", "", "Basket foods"));
    const list = node("ul");
    products.forEach(product => list.append(node("li", "", product.product_name)));
    details.append(list);
    article.append(details);
    return article;
  }

  function render(data) {
    const context = currentPlan?.context || {};
    const dietLabel = displayedDiet(context.diet);
    const planContext = [
      context.days ? `${context.days} ${context.days === 1 ? "day" : "days"}` : "",
      context.people ? `${context.people} ${context.people === 1 ? "person" : "people"}` : "",
      dietLabel,
    ].filter(Boolean).join(" · ");
    document.querySelector("#meal-plan-title").textContent = "Your Meal Plan";
    const headerContext = document.querySelector("#meal-plan-context");
    headerContext.textContent = planContext;
    headerContext.hidden = !planContext;
    document.querySelector(".meal-plan-subtitle").hidden = true;
    document.querySelector("#meal-source-summary").textContent = planContext;
    daysOutput.replaceChildren();
    (data.days || []).forEach(day => {
      const article = node("article", "meal-day-card");
      article.append(node("h3", "", `Day ${day.day}`));
      const meals = node("div", "day-meals");
      (day.meals || []).forEach(meal => meals.append(renderMeal(meal)));
      article.append(meals);
      daysOutput.append(article);
    });
    basketNutritionOutput.replaceChildren();
    const basketNutrition = (data.days || []).find(day => day?.nutrition)?.nutrition || {};
    basketNutritionOutput.append(nutritionSummary(basketNutrition, context.targets || {}));
    document.querySelector("#meal-rotation-note").textContent = data.repeats ? `A ${data.rotation_days}-day meal rotation for your ${data.days_requested}-day grocery plan.` : "";
    ready.hidden = true; results.hidden = false; hasRenderedPlan = true;
    document.dispatchEvent(new CustomEvent("nutricart:meal-rendered", {detail: {mealPlan: data, context: currentPlan?.context || {}}}));
  }

  async function createMealPlan() {
    if (!currentPlan) return;
    if (activeRequest) activeRequest.abort();
    activeRequest = new AbortController();
    const controller = activeRequest;
    const requestedVersion = planVersion;
    createButton.disabled = true; setStatus("Building meals from your current basket…");
    const context = currentPlan.context;
    const payload = {
      groceries: currentPlan.groceries.map(item => ({product_id: String(item.product_id), quantity: item.quantity})),
      people: context.people, days: context.days, diet: context.diet,
      food_group_exclusions: context.food_group_exclusions || [], foods_to_avoid: context.foods_to_avoid || [],
      nutrition_focus: context.nutrition_focus || "none", targets: context.targets || {},
    };
    try {
      const response = await fetch("/api/meal-plan", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload), signal: controller.signal});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { const requestError = new Error(data.error || "NutriCart could not create this meal plan."); requestError.status = response.status; throw requestError; }
      if (requestedVersion !== planVersion) return;
      render(data); setStatus("Meal plan created from your current grocery basket.", false, true);
    } catch (requestError) {
      if (requestError.name !== "AbortError" && requestedVersion === planVersion) setStatus(requestError.status < 500 ? requestError.message : "We couldn't create meals right now. Your grocery plan is still available — try again.", true);
    } finally {
      if (activeRequest === controller) activeRequest = null;
      if (requestedVersion === planVersion) createButton.disabled = false;
    }
  }

  function applyCurrentPlan(detail = {}) {
    const revision = Number(detail.revision);
    if (Number.isFinite(revision) && revision === currentPlanRevision) return;
    if (activeRequest) activeRequest.abort();
    activeRequest = null;
    planVersion += 1;
    if (Number.isFinite(revision)) currentPlanRevision = revision;
    createButton.disabled = false;
    const changed = hasRenderedPlan;
    currentPlan = {groceries: (detail.plannedItems || []).map(item => ({...item})), context: {...(detail.context || {})}};
    hasRenderedPlan = false; results.hidden = true; results.querySelectorAll(".meal-day-card").forEach(card => card.remove());
    document.querySelector("#meal-plan-title").textContent = "Meal Plan";
    document.querySelector("#meal-plan-context").hidden = true;
    document.querySelector(".meal-plan-subtitle").hidden = false;
    empty.hidden = currentPlan.groceries.length > 0; ready.hidden = !currentPlan.groceries.length;
    setStatus(changed ? "Your grocery plan changed. Generate a new Meal Plan to match your current basket." : "");
  }

  document.addEventListener("nutricart:plan-updated", event => {
    applyCurrentPlan(event.detail || {});
  });
  document.addEventListener("nutricart:account-signed-out", () => {
    if (activeRequest) activeRequest.abort();
    activeRequest = null;
    planVersion += 1;
    currentPlan = null;
    currentPlanRevision = -1;
    hasRenderedPlan = false;
    results.hidden = true;
    results.querySelectorAll(".meal-day-card").forEach(card => card.remove());
    daysOutput.replaceChildren();
    basketNutritionOutput.replaceChildren();
    document.querySelector("#meal-plan-title").textContent = "Meal Plan";
    document.querySelector("#meal-plan-context").textContent = "";
    document.querySelector("#meal-plan-context").hidden = true;
    document.querySelector(".meal-plan-subtitle").hidden = false;
    document.querySelector("#meal-source-summary").textContent = "";
    empty.hidden = false;
    ready.hidden = true;
    createButton.disabled = false;
    setStatus("");
  });
  document.addEventListener("nutricart:navigate", event => {
    if (event.detail?.view !== "meal") return;
    const snapshot = window.NutriCartPlanState?.get();
    if (snapshot) applyCurrentPlan(snapshot);
  });
  const lockedAction = document.querySelector("#create-plan-from-meals");
  lockedAction.addEventListener("click", () => navigate(lockedAction.dataset.workflowTarget || "planner"));
  document.addEventListener("nutricart:create-meal-plan", createMealPlan);
  document.addEventListener("nutricart:open-saved-meal", event => {
    const saved = event.detail?.data;
    if (!saved?.mealPlan) return;
    currentPlan = {groceries: saved.groceries || [], context: saved.context || {targets: {}}};
    render(saved.mealPlan); navigate("meal"); setStatus("Saved meal plan opened.", false, true);
  });
  document.querySelector("#meal-back-to-budget").addEventListener("click", () => navigate("budget"));
  document.querySelector("#meal-back-to-plan").addEventListener("click", () => navigate("planner"));
  document.querySelector("#meal-back-to-basket").addEventListener("click", () => navigate("planner"));
  document.querySelector("#meal-plan-another").addEventListener("click", () => {
    navigate("planner");
    document.querySelector("#edit-plan").click();
  });
  document.querySelector("#meal-find-snap").addEventListener("click", () => navigate("snap"));
  document.querySelector("#meal-compare-basket").addEventListener("click", () => { navigate("planner"); setTimeout(() => document.dispatchEvent(new Event("nutricart:open-comparison")), 420); });
  createButton.addEventListener("click", createMealPlan);
})();
