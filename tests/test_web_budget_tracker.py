import unittest
from pathlib import Path

import app


ROOT = Path(__file__).resolve().parents[1]


class ShoppingBudgetPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.page = app.app.test_client().get("/").get_data(as_text=True)
        cls.script = (ROOT / "static" / "budget_tracker.js").read_text(encoding="utf-8")
        cls.grocery_script = (ROOT / "static" / "grocery.js").read_text(encoding="utf-8")
        cls.styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")

    def test_three_view_navigation_and_planner_default(self):
        for identifier in ("planner-tab", "shopping-budget-tab", "snap-tab"):
            self.assertIn(f'id="{identifier}"', self.page)
        self.assertIn('id="snap-tab" class="tab"', self.page)
        self.assertIn('id="shopping-budget-view" class="app-view budget-view"', self.page)
        self.assertIn('id="snap-view" class="app-view"', self.page)
        self.assertIn("budget: budgetView", self.grocery_script)

    def test_dashboard_has_all_required_controls_and_outputs(self):
        required = (
            "starting-budget", "budget-remaining", "budget-spent", "budget-status-copy",
            "budget-progress-fill", "purchase-item", "purchase-store", "purchase-cost",
            "add-purchase", "purchase-log", "undo-purchase", "clear-purchases",
            "new-budget-session", "budget-live-status",
        )
        for identifier in required:
            with self.subTest(identifier=identifier):
                self.assertIn(f'id="{identifier}"', self.page)
        self.assertIn('id="purchase-store-disclosure"', self.page)
        self.assertIn("+ Add store (optional)", self.page)
        self.assertIn("Record Purchase", self.page)
        self.assertIn("budget_tracker.js?v=simplified-ui-18", self.page)

    def test_forms_have_real_validation_hooks(self):
        self.assertIn('id="purchase-item" type="text"', self.page)
        self.assertIn('id="purchase-cost" type="text"', self.page)
        self.assertIn("const item = itemInput.value.trim()", self.script)
        self.assertIn("if (!item)", self.script)
        self.assertIn("if (costCents === null)", self.script)
        self.assertIn("allowZero ? cents >= 0 : cents > 0", self.script)
        self.assertIn("Number.isSafeInteger(cents)", self.script)

    def test_purchase_rows_offer_edit_before_remove(self):
        row = self.script.split("function purchaseRow", 1)[1].split("function renderLog", 1)[0]
        self.assertIn('edit.textContent = "Edit"', row)
        self.assertIn('remove.textContent = "Remove"', row)
        self.assertLess(row.index('actions.append(edit, remove)'), row.index('article.append(details, deduction, actions)'))
        self.assertIn('data-edit-purchase-form', self.script)

    def test_inline_edit_validates_and_updates_integer_cent_state(self):
        submit = self.script.split('log.addEventListener("submit"', 1)[1].split('log.addEventListener("keydown"', 1)[0]
        self.assertIn('form.elements.namedItem("item")', submit)
        self.assertIn('form.elements.namedItem("store")', submit)
        self.assertIn('form.elements.namedItem("cost")', submit)
        self.assertIn("itemControl.value.trim()", submit)
        self.assertIn("storeControl.value.trim()", submit)
        self.assertIn("parseCents(costControl.value, true)", submit)
        self.assertIn("purchase.costCents = costCents", submit)
        self.assertIn("renderTotals(`${item} updated to ${formatMoney(costCents)}.`)", submit)
        self.assertNotIn("startingCents =", submit)
        self.assertIn("allowZero ? cents >= 0 : cents > 0", self.script)

    def test_edit_cancel_and_escape_discard_without_recalculating(self):
        click = self.script.split('log.addEventListener("click"', 1)[1].split('log.addEventListener("submit"', 1)[0]
        cancel = click.split("const cancelButton", 1)[1].split("const button", 1)[0]
        self.assertIn("editingPurchaseId = null", cancel)
        self.assertIn("renderLog()", cancel)
        self.assertNotIn("renderTotals", cancel)
        escape = self.script.split('log.addEventListener("keydown"', 1)[1].split('document.querySelector("#undo-purchase")', 1)[0]
        self.assertIn('event.key !== "Escape"', escape)
        self.assertIn("event.preventDefault()", escape)
        self.assertNotIn("renderTotals", escape)

    def test_edit_form_keyboard_and_accessibility_contract(self):
        self.assertIn('save.type = "submit"', self.script)
        self.assertIn('cancel.type = "button"', self.script)
        self.assertIn('error.setAttribute("role", "alert")', self.script)
        self.assertIn('input.inputMode = "decimal"', self.script)
        self.assertIn(".budget-purchase-edit {", self.styles)
        self.assertIn(".budget-edit-actions button { min-height: 44px", self.styles)

    def test_currency_uses_integer_cent_arithmetic(self):
        self.assertIn("Number(dollars) * 100", self.script)
        self.assertIn("Number(fraction.padEnd(2, \"0\"))", self.script)
        self.assertIn("sum + purchase.costCents", self.script)
        self.assertIn("startingCents - spent", self.script)
        self.assertIn("Math.floor(absolute / 100)", self.script)
        self.assertIn('String(absolute % 100).padStart(2, "0")', self.script)
        self.assertNotIn("toFixed(2) -", self.script)

    def test_purchase_log_allows_duplicates_and_manual_prices(self):
        self.assertIn("purchases.push(purchase)", self.script)
        self.assertNotIn("purchases.find(entry => entry.item", self.script)
        self.assertIn("costInput.value", self.script)
        self.assertNotIn("unit_price", self.script)
        self.assertIn("deduction.textContent = `-${formatMoney(purchase.costCents)}`", self.script)

    def test_remove_undo_clear_and_new_session_recalculate(self):
        self.assertIn("purchases = purchases.filter", self.script)
        self.assertIn("const purchase = purchases.pop()", self.script)
        self.assertIn('window.confirm("Clear all purchases', self.script)
        self.assertIn('renderTotals("All purchases cleared. Starting budget kept.")', self.script)
        self.assertIn("sessionStarted = false", self.script)
        self.assertIn("initializeFromPlanner(document.querySelector(\"#budget\").value)", self.script)

    def test_over_budget_and_zero_states_are_explicit(self):
        self.assertIn('remaining < 0 ? `${formatMoney(-remaining)} OVER BUDGET`', self.script)
        self.assertIn('remaining === 0) statusCopy.textContent = "BUDGET FULLY USED"', self.script)
        self.assertIn('card.classList.toggle("is-over-budget", remaining < 0)', self.script)
        self.assertIn(".budget-balance-card.is-over-budget", self.styles)

    def test_planner_budget_is_one_way_session_initialization(self):
        self.assertIn("if (sessionStarted && !canAdoptPlannerBudget) return", self.script)
        self.assertIn("!budgetReady && purchases.length === 0", self.script)
        self.assertIn("plannerBudget: currentPlan?.context?.budget ?? document.querySelector(\"#budget\").value", self.grocery_script)
        self.assertNotIn("startingInput.addEventListener", self.grocery_script)
        self.assertNotIn("total_cost", self.script)
        self.assertNotIn("remaining_budget", self.script)

    def test_current_plan_drives_accessible_purchase_selection(self):
        self.assertIn('id="planned-purchase-select"', self.page)
        self.assertIn('for="planned-purchase-select"', self.page)
        self.assertIn("plannedItems: currentResult?.groceries || []", self.grocery_script)
        self.assertIn("plannedItems: currentResult.groceries || []", self.grocery_script)
        self.assertIn("updatePlannedItems(event.detail?.plannedItems)", self.script)
        self.assertNotIn("Harris Teeter Chicken Breast", self.script)
        self.assertNotIn("Bananas — $1.70", self.script)

    def test_planned_selection_uses_item_total_and_fills_editable_fields(self):
        self.assertIn("itemInput.value = item.product_name.trim()", self.script)
        self.assertIn("parseCents(item.item_total)", self.script)
        self.assertNotIn("parseCents(item.unit_price)", self.script)
        self.assertIn("costInput.value = plannedCents", self.script)
        self.assertIn('id="purchase-cost" type="text"', self.page)
        self.assertIn("Planned estimate — confirm or replace it with the actual checkout price.", self.page)
        selection_body = self.script.split('plannedSelect.addEventListener("change"', 1)[1].split('itemInput.addEventListener', 1)[0]
        self.assertNotIn("purchases.push", selection_body)

    def test_store_is_only_filled_from_returned_metadata(self):
        self.assertIn('typeof item.store_name === "string" ? item.store_name.trim() : ""', self.script)
        self.assertNotIn('storeInput.value = "Harris Teeter"', self.script)
        self.assertNotIn('storeInput.value = "Walmart"', self.script)

    def test_other_clears_autofill_and_manual_entry_remains_available(self):
        self.assertIn("Other / Not on my plan", self.page)
        self.assertIn('other.textContent = "Other / Not on my plan"', self.script)
        other_body = self.script.split('plannedSelect.value === "other"', 1)[1].split("const item = plannedItems", 1)[0]
        for clearing in ('itemInput.value = ""', 'storeInput.value = ""', 'costInput.value = ""'):
            self.assertIn(clearing, other_body)
        self.assertIn('placeholder="Enter item"', self.page)
        self.assertIn('<label for="purchase-store">Store (optional)</label>', self.page)

    def test_no_plan_fallback_and_repeated_planned_items(self):
        self.assertIn('id="no-plan-message"', self.page)
        self.assertIn("Shopping without a plan?", self.page)
        self.assertIn("Record purchases here", self.page)
        self.assertIn("build a basket to use its checklist", self.page)
        self.assertIn("picker.hidden = plannedItems.length === 0", self.script)
        self.assertIn("purchases.push(purchase)", self.script)
        self.assertNotIn("plannedItems.splice", self.script)
        self.assertNotIn("plannedItems.filter(entry => entry.product_id", self.script)

    def test_create_plan_action_navigates_without_reset_or_reload(self):
        self.assertIn('id="create-grocery-plan"', self.page)
        self.assertIn("Build Your Basket", self.page)
        action = self.script.split('querySelector("#create-grocery-plan")', 1)[1].split("startingForm.addEventListener", 1)[0]
        self.assertIn('CustomEvent("nutricart:navigate", {detail: {view: "planner"}})', action)
        for forbidden in ("location", "reload", "purchases =", "startingCents", "fetch(", "generate("):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, action)
        navigation = self.grocery_script.split('document.addEventListener("nutricart:navigate"', 1)[1].split('document.querySelector("#snap-back-to-plan")', 1)[0]
        self.assertIn("switchView(event.detail.view)", navigation)
        self.assertNotIn("generate(", navigation)

    def test_no_plan_panel_and_planned_selector_are_mutually_exclusive(self):
        update = self.script.split("function updatePlannedItems", 1)[1].split("function revealIntroEntry", 1)[0]
        self.assertIn("picker.hidden = plannedItems.length === 0", update)
        self.assertIn("noPlan.hidden = plannedItems.length > 0", update)
        self.assertIn('for="planned-purchase-select">Select from your plan', self.page)

    def test_alternative_plan_changes_suggestions_not_logged_purchases(self):
        listener = self.script.split('document.addEventListener("nutricart:plan-updated"', 1)[1].split("startingForm.addEventListener", 1)[0]
        self.assertIn("updatePlannedItems", listener)
        self.assertNotIn("purchases", listener)

    def test_budget_opens_directly_without_an_intro_gateway(self):
        self.assertNotIn('id="budget-intro"', self.page)
        self.assertNotIn("playIntro", self.script)
        self.assertIn("dashboard.hidden = false", self.script)

    def test_successful_purchase_returns_focus_to_item_for_rapid_entry(self):
        submit = self.script.split('purchaseForm.addEventListener("submit"', 1)[1].split('log.addEventListener("click"', 1)[0]
        self.assertIn("purchaseForm.reset()", submit)
        self.assertIn("storeDisclosure.open = false", submit)
        self.assertIn("itemInput.focus()", submit)

    def test_mobile_quick_add_uses_native_submit_and_decimal_keyboard(self):
        form = self.page.split('id="purchase-form"', 1)[1].split("</form>", 1)[0]
        self.assertIn("Record What You Bought", form)
        self.assertIn('id="purchase-cost" type="text" inputmode="decimal"', form)
        self.assertIn('id="add-purchase"', form)
        self.assertLess(form.index('for="purchase-item"'), form.index('for="purchase-cost"'))
        self.assertLess(form.index('for="purchase-cost"'), form.index('id="purchase-store-disclosure"'))
        self.assertIn('purchaseForm.addEventListener("submit"', self.script)

    def test_optional_store_and_planned_items_use_accessible_disclosures(self):
        self.assertIn('<details id="purchase-store-disclosure"', self.page)
        self.assertIn('<summary>+ Add store (optional)</summary>', self.page)
        self.assertIn('<details id="planned-purchase-picker"', self.page)
        self.assertIn('<summary>Planned items from your grocery plan</summary>', self.page)
        self.assertEqual(self.page.count('id="purchase-store"'), 1)

    def test_starting_budget_editor_is_compact_cancellable_and_focus_safe(self):
        self.assertIn('<details id="starting-budget-editor"', self.page)
        self.assertIn('id="cancel-starting-budget"', self.page)
        self.assertIn("startingEditor.open = false", self.script)
        self.assertIn('querySelector("#cancel-starting-budget").addEventListener', self.script)
        self.assertIn("startingEditor.open = true", self.script)

    def test_newest_purchase_renders_first_without_changing_undo_order(self):
        self.assertIn("purchases.slice().reverse().map", self.script)
        self.assertIn("const purchase = purchases.pop()", self.script)

    def test_mobile_summary_combines_status_and_avoids_duplicate_controls(self):
        balance = self.page.split('id="budget-balance-card"', 1)[1].split('</section>', 1)[0]
        self.assertIn('class="budget-status-card"', balance)
        self.assertIn('id="starting-budget-editor"', balance)
        self.assertEqual(self.page.count('id="starting-budget-form"'), 1)
        self.assertEqual(self.page.count('id="budget-progress-fill"'), 1)
        self.assertIn(".budget-money-primary { margin: 2px 0 12px", self.styles)

    def test_reduced_motion_skips_money_animation(self):
        animate_body = self.script.split("function animateMoney", 1)[1].split("function spentCents", 1)[0]
        self.assertIn("reduceMotion.matches", animate_body)
        self.assertIn("element.textContent = formatMoney(toCents)", animate_body)

    def test_animation_and_accessibility_hooks_exist(self):
        self.assertIn("function animateMoney", self.script)
        self.assertIn("requestAnimationFrame(frame)", self.script)
        self.assertIn("purchase.id === newId", self.script)
        self.assertIn("aria-live=\"polite\"", self.page)
        self.assertIn("aria-label", self.script)
        self.assertIn("role=\"progressbar\"", self.page)
        self.assertIn("@keyframes purchase-arrival", self.styles)
        self.assertIn("@keyframes budget-stage", self.styles)

    def test_typography_mobile_and_reduced_motion(self):
        self.assertIn('--font-ui: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', self.styles)
        self.assertNotIn('"Arial Narrow"', self.styles)
        self.assertNotIn('"Bahnschrift"', self.styles)
        self.assertIn("font-variant-numeric: tabular-nums", self.styles)
        self.assertIn("@media (max-width: 700px)", self.styles)
        self.assertIn(".budget-purchase-panel { order: 2; }", self.styles)
        self.assertIn("@media (prefers-reduced-motion: reduce)", self.styles)
        self.assertIn('matchMedia("(prefers-reduced-motion: reduce)")', self.script)

    def test_tracker_is_private_and_client_only(self):
        lowered = self.script.lower()
        for forbidden in ("localstorage", "sessionstorage", "indexeddb", "document.cookie", "fetch(", "xmlhttprequest"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, lowered)
        self.assertNotIn("/api/", self.script)
        self.assertNotIn("http://", self.page.replace("http://www.w3.org/2000/svg", ""))
        self.assertNotIn("https://fonts", self.page)
        self.assertNotIn("fonts.googleapis", self.page)

    def test_current_plan_populates_a_distinct_accessible_shopping_list(self):
        for identifier in ("shopping-list-panel", "shopping-list-items", "shopping-list-progress-text",
                           "hide-collected", "select-all-shopping", "reset-shopping-checks", "shopping-list-create-plan"):
            self.assertIn(f'id="{identifier}"', self.page)
        self.assertIn('role="progressbar" aria-label="In-store checklist progress"', self.page)
        self.assertIn("updateShoppingList(plannedItems)", self.script)
        self.assertIn("name: item.product_name.trim()", self.script)
        self.assertIn("quantity: Number(item.quantity) || 1", self.script)
        self.assertIn("quantity.textContent = packageDisplay(item)", self.script)

    def test_checking_items_updates_progress_without_touching_budget_math(self):
        handler = self.script.split('shoppingListItems.addEventListener("change"', 1)[1].split('shoppingListItems.addEventListener("click"', 1)[0]
        self.assertIn("item.checked = checkbox.checked", handler)
        self.assertIn("renderShoppingList(item.key)", handler)
        for forbidden in ("purchases", "startingCents", "renderTotals", "costCents"):
            self.assertNotIn(forbidden, handler)
        render = self.script.split("function renderShoppingList", 1)[1].split("function updateShoppingList", 1)[0]
        self.assertIn('`${collected} of ${total} collected`', render)
        self.assertIn('setAttribute("aria-valuenow", String(collected))', render)

    def test_hide_collected_reset_and_all_collected_state_are_independent(self):
        self.assertIn("shoppingItems.filter(item => !item.checked)", self.script)
        self.assertIn("shopping-list-all-collected", self.page)
        reset = self.script.split('resetShoppingChecks.addEventListener("click"', 1)[1].split('startingForm.addEventListener', 1)[0]
        self.assertIn("item.checked = false", reset)
        self.assertIn("Purchases and budget were not changed", reset)
        self.assertNotIn("purchases =", reset)
        self.assertNotIn("renderTotals", reset)

    def test_record_purchase_prefills_item_but_never_planned_price(self):
        handler = self.script.split('shoppingListItems.addEventListener("click"', 1)[1].split('hideCollected.addEventListener', 1)[0]
        self.assertIn("itemInput.value = item.name", handler)
        self.assertIn('costInput.value = ""', handler)
        self.assertIn("costInput.focus", handler)
        self.assertNotIn("item_total", handler)
        self.assertNotIn("purchases.push", handler)

    def test_fresh_shopping_budget_is_explicitly_unset(self):
        self.assertIn('id="budget-remaining" class="budget-money budget-money-primary">Not set</strong>', self.page)
        self.assertIn('id="budget-starting-display" class="budget-money">Not set</strong>', self.page)
        starting = self.page.split('id="starting-budget"', 1)[1].split(">", 1)[0]
        self.assertNotIn('value="100.00"', starting)
        self.assertIn('placeholder="100.00"', starting)
        self.assertIn("let startingCents = 0", self.script)
        self.assertIn("let budgetReady = false", self.script)
        unset = self.script.split("if (!budgetReady)", 1)[1].split("animateMoney(remainingElement", 1)[0]
        self.assertIn('remainingElement.textContent = "Not set"', unset)
        self.assertIn("Set a starting budget to track spending.", unset)

    def test_checklist_and_actual_spending_are_named_distinctly(self):
        self.assertIn("In-store Checklist", self.page)
        self.assertNotIn("Checking items tracks collection", self.page)
        self.assertIn('addPrice.textContent = "Record Purchase"', self.script)
        self.assertIn("Save Shopping Session", self.page)

    def test_no_plan_checklist_state_and_mobile_layout(self):
        self.assertIn("No grocery plan yet.", self.page)
        self.assertIn("Build a basket to start your checklist.", self.page)
        self.assertIn("shoppingListReady.hidden = total === 0", self.script)
        self.assertIn("shoppingListEmpty.hidden = total > 0", self.script)
        self.assertIn(".shopping-list-row { display: grid", self.styles)
        self.assertIn("min-height: 50px", self.styles)
        shopping_styles = self.styles.split("/* Practical in-store checklist", 1)[1].split("/* Optional nutrition targets", 1)[0]
        self.assertIn("@media (max-width: 700px)", shopping_styles)
        self.assertIn(".shopping-list-panel { order: 4", shopping_styles)
        self.assertIn(".budget-log-panel { order: 3", shopping_styles)

    def test_bulk_collection_never_changes_purchase_totals(self):
        handler = self.script.split('selectAllShopping.addEventListener("click"', 1)[1].split('resetShoppingChecks.addEventListener', 1)[0]
        self.assertIn("item.checked = true", handler)
        self.assertIn("Purchases and budget were not changed", handler)
        for forbidden in ("purchases.push", "renderTotals", "costCents"):
            self.assertNotIn(forbidden, handler)

    def test_quantity_fallback_does_not_invent_package_units(self):
        formatter = self.script.split("function packageDisplay", 1)[1].split("function shoppingRow", 1)[0]
        self.assertIn('return `Quantity: ${quantity}`', formatter)
        self.assertNotIn('quantity === 1 ? "package" : "packages"', formatter)

    def test_same_plan_preserves_checks_and_new_plan_replaces_list(self):
        update = self.script.split("function updateShoppingList", 1)[1].split("function updatePlannedItems", 1)[0]
        self.assertIn("if (nextFingerprint === shoppingPlanFingerprint) return", update)
        self.assertIn("shoppingItems = items", update)
        listener = self.script.split('document.addEventListener("nutricart:plan-updated"', 1)[1].split('querySelector("#create-grocery-plan")', 1)[0]
        self.assertIn("updatePlannedItems(event.detail?.plannedItems)", listener)

    def test_saved_list_state_round_trips_without_optimizer_or_purchase_recalculation(self):
        requested = self.script.split('document.addEventListener("nutricart:request-budget-state"', 1)[1].split('document.addEventListener("nutricart:open-saved-shopping"', 1)[0]
        self.assertIn("shoppingItems:", requested)
        opened = self.script.split('document.addEventListener("nutricart:open-saved-shopping"', 1)[1].split("renderLog();", 1)[0]
        self.assertIn("saved.shoppingItems", opened)
        self.assertIn("checked: item.checked === true", opened)
        self.assertIn("saved.startingBudgetCents", opened)
        self.assertIn("saved.purchases", opened)
        self.assertNotIn("optimiz", opened.lower())
        self.assertNotIn("spentCents", opened)

    def test_high_contrast_large_text_and_native_checkbox_contracts(self):
        row = self.script.split("function shoppingRow", 1)[1].split("function renderShoppingList", 1)[0]
        self.assertIn('checkbox.type = "checkbox"', row)
        self.assertIn("label.append(checkbox", row)
        self.assertIn('[data-high-contrast="true"] .shopping-list-panel', self.styles)
        self.assertIn('[data-text-size="extra-large"] .shopping-list-row', self.styles)


if __name__ == "__main__":
    unittest.main()
