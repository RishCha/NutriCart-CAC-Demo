(() => {
  // Event contracts:
  //   Listens: 'nutricart:budget-opened', 'nutricart:plan-updated', 'nutricart:request-budget-state',
  //            'nutricart:open-saved-shopping'
  //   Dispatches: 'nutricart:budget-state', 'nutricart:navigate'
  const dashboard = document.querySelector("#budget-dashboard");
  const startingForm = document.querySelector("#starting-budget-form");
  const purchaseForm = document.querySelector("#purchase-form");
  const startingInput = document.querySelector("#starting-budget");
  const itemInput = document.querySelector("#purchase-item");
  const storeInput = document.querySelector("#purchase-store");
  const costInput = document.querySelector("#purchase-cost");
  const storeDisclosure = document.querySelector("#purchase-store-disclosure");
  const startingEditor = document.querySelector("#starting-budget-editor");
  const plannedSelect = document.querySelector("#planned-purchase-select");
  const log = document.querySelector("#purchase-log");
  const emptyLog = document.querySelector("#empty-purchase-log");
  const liveStatus = document.querySelector("#budget-live-status");
  const budgetStoreContext = document.querySelector("#budget-store-context");
  const purchaseSuccess = document.querySelector("#purchase-success");
  const shoppingListLink = document.querySelector("#view-shopping-list");
  shoppingListLink.addEventListener("click", () => {
    const list = document.querySelector("#shopping-list-panel");
    list.focus({preventScroll: true});
    list.scrollIntoView({behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start"});
  });
  const shoppingListReady = document.querySelector("#shopping-list-ready");
  const shoppingListEmpty = document.querySelector("#shopping-list-empty");
  const shoppingListItems = document.querySelector("#shopping-list-items");
  const shoppingListProgressText = document.querySelector("#shopping-list-progress-text");
  const shoppingListProgress = document.querySelector(".shopping-list-progress");
  const shoppingListProgressFill = document.querySelector("#shopping-list-progress-fill");
  const hideCollected = document.querySelector("#hide-collected");
  const resetShoppingChecks = document.querySelector("#reset-shopping-checks");
  const selectAllShopping = document.querySelector("#select-all-shopping");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let startingCents = 0;
  let purchases = [];
  let nextPurchaseId = 1;
  let sessionStarted = false;
  let plannedItems = [];
  let selectedPlannedItem = null;
  let displayedSpentCents = 0;
  let displayedRemainingCents = 0;
  let budgetReady = false;
  let editingPurchaseId = null;
  let shoppingItems = [];
  let shoppingPlanFingerprint = "";
  let ignoreNextBudgetPlanUpdate = false;
  let restoredShoppingSession = false;
  let purchaseSuccessTimer = null;

  function parseCents(raw, allowZero = false) {
    const normalized = String(raw).trim().replace(/^\$/, "").replace(/,/g, "");
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
    const [dollars, fraction = ""] = normalized.split(".");
    const cents = (Number(dollars) * 100) + Number(fraction.padEnd(2, "0"));
    return Number.isSafeInteger(cents) && (allowZero ? cents >= 0 : cents > 0) ? cents : null;
  }

  function formatMoney(cents) {
    const sign = cents < 0 ? "-" : "";
    const absolute = Math.abs(cents);
    return `${sign}$${Math.floor(absolute / 100).toLocaleString("en-US")}.${String(absolute % 100).padStart(2, "0")}`;
  }

  function renderStoreContext(context) {
    const name = context?.selected_store?.name;
    const storeName = typeof name === "string" ? name.trim() : "";
    budgetStoreContext.textContent = storeName ? `Shopping at ${storeName}` : "";
    budgetStoreContext.hidden = !storeName;
  }

  function clearPurchaseSuccess() {
    if (purchaseSuccessTimer !== null) window.clearTimeout(purchaseSuccessTimer);
    purchaseSuccessTimer = null;
    purchaseSuccess.textContent = "";
    purchaseSuccess.hidden = true;
  }

  function showPurchaseSuccess() {
    clearPurchaseSuccess();
    purchaseSuccess.textContent = "✓ Item has been added!";
    purchaseSuccess.hidden = false;
    itemInput.focus({preventScroll: true});
    requestAnimationFrame(() => {
      purchaseSuccess.scrollIntoView({behavior: reduceMotion.matches ? "instant" : "smooth", block: "nearest"});
    });
    purchaseSuccessTimer = window.setTimeout(clearPurchaseSuccess, 4000);
  }

  function spentCents() {
    return purchases.reduce((sum, purchase) => sum + purchase.costCents, 0);
  }

  function animateMoney(element, fromCents, toCents) {
    if (reduceMotion.matches || window.NutriCartSettings?.getSetting("animatedNumbers") === false || fromCents === toCents) {
      element.textContent = formatMoney(toCents);
      return;
    }
    const started = performance.now();
    const duration = 380;
    function frame(now) {
      const progress = Math.min((now - started) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = formatMoney(Math.round(fromCents + ((toCents - fromCents) * eased)));
      if (progress < 1) requestAnimationFrame(frame);
      else element.textContent = formatMoney(toCents);
    }
    requestAnimationFrame(frame);
  }

  function renderTotals(announcement = "") {
    const spent = spentCents();
    const remaining = startingCents - spent;
    const remainingElement = document.querySelector("#budget-remaining");
    const spentElement = document.querySelector("#budget-spent");
    const card = document.querySelector("#budget-balance-card");
    const overMessage = document.querySelector("#budget-over-message");
    const statusCopy = document.querySelector("#budget-status-copy");
    const progress = document.querySelector(".budget-progress");
    if (!budgetReady) {
      card.classList.add("is-unset");
      remainingElement.textContent = "Not set";
      animateMoney(spentElement, displayedSpentCents, spent);
      displayedRemainingCents = 0;
      displayedSpentCents = spent;
      document.querySelector("#budget-starting-display").textContent = "Not set";
      startingInput.value = "";
      card.classList.remove("is-over-budget", "is-fully-used");
      overMessage.hidden = true;
      overMessage.textContent = "";
      statusCopy.textContent = "Set a starting budget to track spending.";
      document.querySelector("#budget-percent").textContent = "Not set";
      document.querySelector("#budget-progress-fill").style.width = "0%";
      progress.setAttribute("aria-valuenow", "0");
      progress.setAttribute("aria-valuetext", "Starting budget not set");
      if (announcement) liveStatus.textContent = `${announcement} Starting budget is not set.`;
      return;
    }
    card.classList.remove("is-unset");
    animateMoney(remainingElement, displayedRemainingCents, remaining);
    animateMoney(spentElement, displayedSpentCents, spent);
    displayedRemainingCents = remaining;
    displayedSpentCents = spent;
    document.querySelector("#budget-starting-display").textContent = formatMoney(startingCents);
    startingInput.value = (startingCents / 100).toFixed(2);

    card.classList.toggle("is-over-budget", remaining < 0);
    card.classList.toggle("is-fully-used", remaining === 0);
    overMessage.hidden = remaining >= 0;
    overMessage.textContent = remaining < 0 ? `${formatMoney(-remaining)} OVER BUDGET` : "";
    if (remaining < 0) statusCopy.textContent = `${formatMoney(-remaining)} over the ${formatMoney(startingCents)} budget`;
    else if (remaining === 0) statusCopy.textContent = "BUDGET FULLY USED";
    else statusCopy.textContent = `${formatMoney(remaining)} remaining of ${formatMoney(startingCents)}`;

    const percent = startingCents ? Math.max(0, Math.min(100, (remaining / startingCents) * 100)) : 0;
    document.querySelector("#budget-percent").textContent = `${percent.toFixed(percent % 1 ? 1 : 0)}%`;
    document.querySelector("#budget-progress-fill").style.width = `${percent}%`;
    progress.setAttribute("aria-valuenow", String(Math.round(percent)));
    progress.setAttribute("aria-valuetext", remaining < 0 ? `${formatMoney(-remaining)} over budget` : `${Math.round(percent)} percent remaining`);
    if (announcement) liveStatus.textContent = `${announcement} Spent ${formatMoney(spent)}. Remaining ${formatMoney(remaining)}.`;
  }

  function purchaseRow(purchase, animate = false) {
    const article = document.createElement("article");
    article.className = `budget-purchase${animate ? " is-new" : ""}`;
    article.dataset.purchaseId = String(purchase.id);
    const details = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = purchase.item;
    const store = document.createElement("span");
    store.textContent = [purchase.estimated ? "Estimated price" : (purchase.planned ? "Price paid" : ""), purchase.store].filter(Boolean).join(" · ");
    store.hidden = !store.textContent;
    details.append(name, store);
    const deduction = document.createElement("b");
    deduction.textContent = `-${formatMoney(purchase.costCents)}`;
    if (purchase.id === editingPurchaseId) {
      const form = document.createElement("form");
      form.className = "budget-purchase-edit";
      form.dataset.editPurchaseForm = String(purchase.id);
      form.noValidate = true;
      const field = (labelText, name, value, optional = false) => {
        const label = document.createElement("label");
        label.textContent = optional ? `${labelText} (optional)` : labelText;
        const input = document.createElement("input");
        input.type = "text";
        input.name = name;
        input.value = value;
        input.autocomplete = "off";
        if (name === "cost") input.inputMode = "decimal";
        label.append(input);
        return label;
      };
      const itemField = field("Item", "item", purchase.item);
      const storeField = field("Store", "store", purchase.store, true);
      const costField = field("Actual Cost", "cost", (purchase.costCents / 100).toFixed(2));
      const actions = document.createElement("div");
      actions.className = "budget-edit-actions";
      const save = document.createElement("button");
      save.type = "submit";
      save.textContent = "Save Changes";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.dataset.cancelPurchaseEdit = String(purchase.id);
      cancel.textContent = "Cancel";
      const error = document.createElement("p");
      error.className = "budget-edit-error";
      error.dataset.purchaseEditError = String(purchase.id);
      error.setAttribute("role", "alert");
      actions.append(save, cancel);
      form.append(itemField, storeField, costField, actions, error);
      article.append(form);
      return article;
    }
    const actions = document.createElement("div");
    actions.className = "budget-purchase-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "budget-edit";
    edit.dataset.editPurchase = String(purchase.id);
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", `Edit ${purchase.item}`);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "budget-remove";
    remove.dataset.removePurchase = String(purchase.id);
    remove.dataset.cursorEffect = "remove-purchase";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${purchase.item}, ${formatMoney(purchase.costCents)}`);
    actions.append(edit, remove);
    article.append(details, deduction, actions);
    return article;
  }

  function renderLog(newId = null) {
    log.replaceChildren(...purchases.slice().reverse().map(purchase => purchaseRow(purchase, purchase.id === newId)));
    renderShoppingList();
    emptyLog.hidden = purchases.length > 0;
    document.querySelector("#purchase-count").textContent = `${purchases.length} ${purchases.length === 1 ? "item" : "items"}`;
    document.querySelector("#undo-purchase").disabled = purchases.length === 0;
    document.querySelector("#clear-purchases").disabled = purchases.length === 0;
  }

  function fingerprint(items) {
    return JSON.stringify(items.map(item => [String(item.product_id || ""), item.product_name?.trim() || "", Number(item.quantity || 0), item.package_size || ""]));
  }

  function packageDisplay(item) {
    const quantity = Number(item.quantity) || 1;
    const packageSize = typeof item.packageSize === "string" ? item.packageSize.trim() : "";
    if (packageSize) return quantity > 1 ? `${quantity} × ${packageSize}` : packageSize;
    return `Quantity: ${quantity}`;
  }

  function linkedPurchase(item) {
    return item.productId ? purchases.find(entry => entry.planned && entry.productId === item.productId) : null;
  }

  function markPurchased(item, checked, confirmEdited = true) {
    const existing = linkedPurchase(item);
    if (checked && !existing) {
      if (!budgetReady || !item.productId || !Number.isSafeInteger(item.estimatedCents) || item.estimatedCents < 0) {
        liveStatus.textContent = "Set a starting budget and use a listed estimate before marking purchased.";
        return false;
      }
      purchases.push({id: nextPurchaseId++, item: item.name, store: "", costCents: item.estimatedCents,
        planned: true, productId: item.productId, estimated: true});
    } else if (!checked && existing) {
      if (confirmEdited && !existing.estimated && !window.confirm(`Undo the purchase of ${existing.item} at the edited price ${formatMoney(existing.costCents)}?`)) return false;
      purchases = purchases.filter(entry => entry.id !== existing.id);
    }
    return true;
  }

  function shoppingRow(item) {
    const row = document.createElement("div");
    row.className = `shopping-list-row${item.checked ? " is-collected" : ""}`;
    row.dataset.shoppingKey = item.key;
    const label = document.createElement("label");
    label.className = "shopping-list-check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.checked;
    checkbox.dataset.shoppingCheck = item.key;
    checkbox.setAttribute("aria-label", `Mark purchased: ${item.name}`);
    checkbox.disabled = !item.productId || (!item.checked && item.estimatedCents === null);
    const name = document.createElement("span");
    name.className = "shopping-list-name";
    name.textContent = item.name;
    const quantity = document.createElement("span");
    quantity.className = "shopping-list-quantity";
    const purchase = linkedPurchase(item);
    const amount = purchase ? purchase.costCents : item.estimatedCents;
    const price = amount === null ? "Price unavailable" : `${purchase && !purchase.estimated ? "Paid" : "Estimated"} ${formatMoney(amount)}`;
    quantity.textContent = `${packageDisplay(item)} \u00b7 ${price}`;
    label.append(checkbox, name, quantity);
    const addPrice = document.createElement("button");
    addPrice.type = "button";
    addPrice.className = "shopping-list-add-price";
    addPrice.dataset.shoppingAddPrice = item.key;
    addPrice.textContent = "Edit price";
    addPrice.disabled = !purchase;
    addPrice.setAttribute("aria-label", `Edit price paid for ${item.name}`);
    row.append(label, addPrice);
    return row;
  }

  function renderShoppingList(focusKey = null) {
    shoppingItems.forEach(item => { item.checked = Boolean(linkedPurchase(item)); });
    const total = shoppingItems.length;
    const collected = shoppingItems.filter(item => item.checked).length;
    shoppingListReady.hidden = total === 0;
    shoppingListLink.hidden = total === 0;
    shoppingListEmpty.hidden = total > 0;
    shoppingListProgressText.textContent = `${collected} of ${total} purchased`;
    shoppingListProgress.setAttribute("aria-valuemax", String(total));
    shoppingListProgress.setAttribute("aria-valuenow", String(collected));
    shoppingListProgress.setAttribute("aria-valuetext", `${collected} of ${total} items purchased`);
    shoppingListProgressFill.style.width = `${total ? (collected / total) * 100 : 0}%`;
    resetShoppingChecks.disabled = collected === 0;
    selectAllShopping.disabled = total === 0 || collected === total;
    const visible = hideCollected.checked ? shoppingItems.filter(item => !item.checked) : shoppingItems;
    shoppingListItems.replaceChildren(...visible.map(shoppingRow));
    document.querySelector("#shopping-list-all-collected").hidden = !(hideCollected.checked && total > 0 && collected === total);
    if (focusKey) shoppingListItems.querySelector(`[data-shopping-check="${focusKey}"]`)?.focus();
  }

  function updateShoppingList(items = []) {
    const nextFingerprint = fingerprint(items);
    if (nextFingerprint === shoppingPlanFingerprint) return;
    shoppingPlanFingerprint = nextFingerprint;
    shoppingItems = items
      .filter(item => item && typeof item.product_name === "string" && item.product_name.trim())
      .map((item, index) => ({key: `shopping-${index}`, sourceIndex: index, name: item.product_name.trim(), quantity: Number(item.quantity) || 1, packageSize: typeof item.package_size === "string" ? item.package_size : "", packageWeightG: Number(item.package_weight_g) || null, productId: String(item.product_id || ""), estimatedCents: parseCents(item.item_total, true), checked: false}));
    hideCollected.checked = false;
    renderShoppingList();
  }

  function initializeFromPlanner(rawBudget) {
    const usePlannerBudget = window.NutriCartSettings?.getSetting("usePlannerBudget") !== false;
    const plannerCents = usePlannerBudget ? parseCents(rawBudget) : null;
    const canAdoptPlannerBudget = !budgetReady && purchases.length === 0 && plannerCents !== null;
    if (sessionStarted && !canAdoptPlannerBudget) return;
    if (plannerCents !== null) { startingCents = plannerCents; budgetReady = true; }
    else { startingCents = 0; budgetReady = false; }
    sessionStarted = true;
    displayedRemainingCents = budgetReady ? startingCents : 0;
    renderTotals();
  }

  function updatePlannedItems(items = [], updateChecklist = true) {
    const clearStaleAutofill = Boolean(selectedPlannedItem);
    plannedItems = items.filter(item => item && typeof item.product_name === "string" && item.product_name.trim());
    const picker = document.querySelector("#planned-purchase-picker");
    const noPlan = document.querySelector("#no-plan-message");
    picker.hidden = plannedItems.length === 0;
    noPlan.hidden = plannedItems.length > 0;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select from your grocery plan";
    const options = plannedItems.map((item, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      const priceCents = parseCents(item.item_total);
      option.textContent = `${item.product_name.trim()} — ${priceCents === null ? "Price unavailable" : formatMoney(priceCents)}`;
      return option;
    });
    const other = document.createElement("option");
    other.value = "other";
    other.textContent = "Other / Not on my plan";
    plannedSelect.replaceChildren(placeholder, ...options, other);
    selectedPlannedItem = null;
    if (clearStaleAutofill) {
      itemInput.value = "";
      storeInput.value = "";
      costInput.value = "";
    }
    document.querySelector("#planned-price-help").hidden = true;
    if (updateChecklist) updateShoppingList(plannedItems);
  }

  document.addEventListener("nutricart:budget-opened", event => {
    initializeFromPlanner(event.detail?.plannerBudget);
    renderStoreContext(event.detail?.context);
    if (ignoreNextBudgetPlanUpdate) ignoreNextBudgetPlanUpdate = false;
    else if (!restoredShoppingSession) updatePlannedItems(event.detail?.plannedItems);
    dashboard.hidden = false;
  });
  document.addEventListener("nutricart:plan-updated", event => {
    restoredShoppingSession = false;
    renderStoreContext(event.detail?.context);
    updatePlannedItems(event.detail?.plannedItems);
  });
  [document.querySelector("#create-grocery-plan"), document.querySelector("#shopping-list-create-plan")].forEach(button => button.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("nutricart:navigate", {detail: {view: "planner"}}));
  }));

  shoppingListItems.addEventListener("change", event => {
    const checkbox = event.target.closest("[data-shopping-check]");
    if (!checkbox) return;
    const item = shoppingItems.find(entry => entry.key === checkbox.dataset.shoppingCheck);
    if (!item) return;
    const changed = markPurchased(item, checkbox.checked);
    renderLog();
    renderShoppingList(item.key);
    renderTotals(changed ? `${item.name}: purchase ${checkbox.checked ? "added at estimated price" : "undone"}.` : "Purchase unchanged.");
  });

  shoppingListItems.addEventListener("click", event => {
    const button = event.target.closest("[data-shopping-add-price]");
    if (!button) return;
    const item = shoppingItems.find(entry => entry.key === button.dataset.shoppingAddPrice);
    if (!item) return;
    const purchase = linkedPurchase(item);
    if (!purchase) return;
    editingPurchaseId = purchase.id;
    renderLog();
    const field = log.querySelector(`[data-edit-purchase-form="${purchase.id}"] input[name="cost"]`);
    field?.focus();
    field?.select();
  });

  hideCollected.addEventListener("change", () => renderShoppingList());
  selectAllShopping.addEventListener("click", () => {
    if (!window.confirm("Mark all listed items purchased at their estimated prices? Existing purchases keep their prices.")) return;
    shoppingItems.forEach(item => markPurchased(item, true));
    renderLog();
    renderTotals("Listed purchases updated.");
  });
  resetShoppingChecks.addEventListener("click", () => {
    if (!shoppingItems.some(item => linkedPurchase(item))) return;
    if (!window.confirm("Undo all listed purchases, including any edited prices? Additional purchases will be kept.")) return;
    shoppingItems.forEach(item => markPurchased(item, false, false));
    hideCollected.checked = false;
    renderLog();
    renderTotals("Listed purchases undone.");
  });

  plannedSelect.addEventListener("change", () => {
    clearPurchaseSuccess();
    if (plannedSelect.value === "other" || plannedSelect.value === "") {
      selectedPlannedItem = null;
      itemInput.value = "";
      storeInput.value = "";
      costInput.value = "";
      document.querySelector("#planned-price-help").hidden = true;
      itemInput.focus();
      return;
    }
    const item = plannedItems[Number(plannedSelect.value)];
    if (!item) return;
    selectedPlannedItem = item;
    itemInput.value = item.product_name.trim();
    storeInput.value = typeof item.store_name === "string" ? item.store_name.trim() : "";
    const plannedCents = parseCents(item.item_total);
    costInput.value = plannedCents === null ? "" : (plannedCents / 100).toFixed(2);
    document.querySelector("#planned-price-help").hidden = plannedCents === null;
  });

  itemInput.addEventListener("input", () => {
    clearPurchaseSuccess();
    if (selectedPlannedItem && itemInput.value.trim() !== selectedPlannedItem.product_name.trim()) {
      selectedPlannedItem = null;
      plannedSelect.value = "other";
      document.querySelector("#planned-price-help").hidden = true;
    }
  });

  startingForm.addEventListener("submit", event => {
    event.preventDefault();
    const cents = parseCents(startingInput.value);
    const error = document.querySelector("#starting-budget-error");
    if (cents === null) {
      error.textContent = "Enter a positive budget with no more than two decimal places.";
      return;
    }
    error.textContent = "";
    startingCents = cents;
    budgetReady = true;
    renderTotals("Starting budget updated.");
    startingEditor.open = false;
  });

  document.querySelector("#cancel-starting-budget").addEventListener("click", () => {
    startingInput.value = budgetReady ? (startingCents / 100).toFixed(2) : "";
    document.querySelector("#starting-budget-error").textContent = "";
    startingEditor.open = false;
    startingEditor.querySelector("summary").focus();
  });

  purchaseForm.addEventListener("submit", event => {
    event.preventDefault();
    clearPurchaseSuccess();
    if (!budgetReady) {
      document.querySelector("#purchase-error").textContent = "Set a Starting Budget before adding purchases.";
      startingEditor.open = true;
      startingInput.focus();
      return;
    }
    const item = itemInput.value.trim();
    const costCents = parseCents(costInput.value);
    const error = document.querySelector("#purchase-error");
    if (!item) {
      error.textContent = "Enter an item name.";
      itemInput.focus();
      return;
    }
    if (costCents === null) {
      error.textContent = "Enter a positive cost with no more than two decimal places.";
      costInput.focus();
      return;
    }
    error.textContent = "";
    const existing = selectedPlannedItem?.product_id ? linkedPurchase({productId: selectedPlannedItem.product_id}) : null;
    const purchase = {id: existing?.id || nextPurchaseId++, item, store: storeInput.value.trim(), costCents,
      planned: Boolean(selectedPlannedItem), productId: selectedPlannedItem?.product_id || null, estimated: false};
    if (existing) Object.assign(existing, purchase);
    else purchases.push(purchase);
    renderLog(purchase.id);
    renderTotals(`${item} added for ${formatMoney(costCents)}.`);
    purchaseForm.reset();
    selectedPlannedItem = null;
    document.querySelector("#planned-price-help").hidden = true;
    storeDisclosure.open = false;
    showPurchaseSuccess();
  });

  [costInput, storeInput].forEach(input => input.addEventListener("input", clearPurchaseSuccess));

  log.addEventListener("click", event => {
    const editButton = event.target.closest("[data-edit-purchase]");
    if (editButton) {
      editingPurchaseId = Number(editButton.dataset.editPurchase);
      renderLog();
      log.querySelector(`[data-edit-purchase-form="${editingPurchaseId}"] input[name="item"]`)?.focus();
      return;
    }
    const cancelButton = event.target.closest("[data-cancel-purchase-edit]");
    if (cancelButton) {
      const id = Number(cancelButton.dataset.cancelPurchaseEdit);
      editingPurchaseId = null;
      renderLog();
      log.querySelector(`[data-edit-purchase="${id}"]`)?.focus();
      return;
    }
    const button = event.target.closest("[data-remove-purchase]");
    if (!button) return;
    const id = Number(button.dataset.removePurchase);
    const purchase = purchases.find(entry => entry.id === id);
    purchases = purchases.filter(entry => entry.id !== id);
    renderLog();
    renderTotals(`${purchase?.item || "Purchase"} removed.`);
  });

  log.addEventListener("submit", event => {
    const form = event.target.closest("[data-edit-purchase-form]");
    if (!form) return;
    event.preventDefault();
    const id = Number(form.dataset.editPurchaseForm);
    const itemControl = form.elements.namedItem("item");
    const storeControl = form.elements.namedItem("store");
    const costControl = form.elements.namedItem("cost");
    const item = itemControl.value.trim();
    const store = storeControl.value.trim();
    const costCents = parseCents(costControl.value, true);
    const error = form.querySelector("[data-purchase-edit-error]");
    if (!item) {
      error.textContent = "Enter an item name.";
      itemControl.focus();
      return;
    }
    if (costCents === null) {
      error.textContent = "Enter a cost of $0 or more with no more than two decimal places.";
      costControl.focus();
      return;
    }
    const purchase = purchases.find(entry => entry.id === id);
    if (!purchase) return;
    purchase.item = item;
    purchase.store = store;
    purchase.costCents = costCents;
    purchase.estimated = false;
    editingPurchaseId = null;
    renderLog();
    renderTotals(`${item} updated to ${formatMoney(costCents)}.`);
    log.querySelector(`[data-edit-purchase="${id}"]`)?.focus();
  });

  log.addEventListener("keydown", event => {
    const form = event.target.closest("[data-edit-purchase-form]");
    if (!form || event.key !== "Escape") return;
    event.preventDefault();
    const id = Number(form.dataset.editPurchaseForm);
    editingPurchaseId = null;
    renderLog();
    log.querySelector(`[data-edit-purchase="${id}"]`)?.focus();
  });

  document.querySelector("#undo-purchase").addEventListener("click", () => {
    const purchase = purchases.pop();
    if (!purchase) return;
    renderLog();
    renderTotals(`${purchase.item} undone.`);
  });

  document.querySelector("#clear-purchases").addEventListener("click", () => {
    if (!purchases.length) return;
    if (!window.confirm("Clear all purchases from this shopping session?")) return;
    purchases = [];
    editingPurchaseId = null;
    renderLog();
    renderTotals("All purchases cleared. Starting budget kept.");
  });

  document.querySelector("#new-budget-session").addEventListener("click", () => {
    if (purchases.length && !window.confirm("Start a new session and clear all purchases?")) return;
    purchases = [];
    editingPurchaseId = null;
    sessionStarted = false;
    restoredShoppingSession = false;
    nextPurchaseId = 1;
    shoppingItems.forEach(item => { item.checked = false; });
    hideCollected.checked = false;
    renderShoppingList();
    initializeFromPlanner(document.querySelector("#budget").value);
    renderLog();
    renderTotals("New shopping session started.");
    startingEditor.open = true;
    startingInput.focus();
    startingInput.select();
  });

  document.addEventListener("nutricart:request-budget-state", () => {
    document.dispatchEvent(new CustomEvent("nutricart:budget-state", {detail: {
      startingBudgetCents: startingCents,
      purchases: purchases.map(({id: _id, ...purchase}) => ({...purchase})),
      shoppingItems: shoppingItems.map(({key: _key, sourceIndex: _sourceIndex, ...item}) => ({...item})),
    }}));
  });
  document.addEventListener("nutricart:open-saved-shopping", event => {
    const saved = event.detail?.data;
    if (!saved || !Number.isInteger(saved.startingBudgetCents) || !Array.isArray(saved.purchases)) return;
    startingCents = saved.startingBudgetCents;
    purchases = saved.purchases.map(purchase => ({...purchase, id: nextPurchaseId++}));
    shoppingItems = Array.isArray(saved.shoppingItems) ? saved.shoppingItems
      .filter(item => item && typeof item.name === "string" && item.name.trim())
      .map((item, index) => ({key: `saved-shopping-${index}`, sourceIndex: index, name: item.name.trim(), quantity: Number(item.quantity) || 1, packageSize: typeof item.packageSize === "string" ? item.packageSize : "", packageWeightG: Number(item.packageWeightG) || null, productId: typeof item.productId === "string" ? item.productId : "", estimatedCents: Number.isSafeInteger(item.estimatedCents) && item.estimatedCents >= 0 ? item.estimatedCents : null, checked: false})) : [];
    shoppingPlanFingerprint = `saved-${event.detail.id || Date.now()}`;
    updatePlannedItems(shoppingItems.map(item => ({product_id: item.productId, product_name: item.name, quantity: item.quantity, package_size: item.packageSize, item_total: item.estimatedCents === null ? null : (item.estimatedCents / 100).toFixed(2)})), false);
    hideCollected.checked = false;
    renderShoppingList();
    ignoreNextBudgetPlanUpdate = true;
    restoredShoppingSession = true;
    editingPurchaseId = null;
    budgetReady = saved.startingBudgetCents > 0 || saved.purchases.length > 0;
    sessionStarted = true; renderLog(); renderTotals("Saved shopping session opened.");
    document.dispatchEvent(new CustomEvent("nutricart:navigate", {detail: {view: "budget"}}));
  });

  renderLog();
  renderTotals();
  renderShoppingList();
})();
