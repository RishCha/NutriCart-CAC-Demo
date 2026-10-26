// Display-only shopping amounts. Never changes model quantities, prices or data.
(() => {
  const GRAMS_PER_OUNCE = 28.349523125;
  const GRAMS_PER_POUND = 453.59237;
  const number = (value, digits = 1) => new Intl.NumberFormat("en-US", {maximumFractionDigits: digits}).format(value);

  function describe(item = {}) {
    const quantity = Number(item.quantity);
    const size = typeof (item.package_size ?? item.packageSize) === "string"
      ? (item.package_size ?? item.packageSize).trim() : "";
    let unitGrams = Number(item.package_weight_g ?? item.packageWeightG);
    if (!Number.isFinite(unitGrams) || unitGrams <= 0) {
      // Legacy plans may have only explicit mass text. Never parse counts or volumes.
      const mass = size.match(/^(\d+(?:\.\d+)?)\s*(g|kg|oz|lb|lbs)\.?$/i);
      const factors = {g: 1, kg: 1000, oz: GRAMS_PER_OUNCE, lb: GRAMS_PER_POUND, lbs: GRAMS_PER_POUND};
      unitGrams = mass ? Number(mass[1]) * factors[mass[2].toLowerCase()] : NaN;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) return {primary: "Quantity unavailable", secondary: "", totalGrams: null};
    const modelSize = size || (Number.isFinite(unitGrams) && unitGrams > 0 ? `${number(unitGrams, 3)} g` : "");
    const secondary = modelSize ? `Model units: ${number(quantity, 3)} \u00d7 ${modelSize}` : "";
    const grams = quantity * unitGrams;
    if (!Number.isFinite(grams) || grams <= 0) return {primary: `Quantity: ${number(quantity, 3)}`, secondary, totalGrams: null};
    const metric = grams >= 1000 ? `${number(grams / 1000, 3)} kg` : `${number(grams, 3)} g`;
    const imperial = grams >= GRAMS_PER_POUND
      ? `${number(grams / GRAMS_PER_POUND)} lb`
      : grams / GRAMS_PER_OUNCE < 0.05 ? "less than 0.1 oz" : `${number(grams / GRAMS_PER_OUNCE)} oz`;
    return {primary: `Need about ${imperial} (${metric})`, secondary, totalGrams: grams};
  }

  window.NutriCartQuantities = Object.freeze({describe});
})();
