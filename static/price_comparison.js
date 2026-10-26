// Reflect the existing comparison availability; never invent retailer prices.
(() => {
  const button = document.querySelector("#compare-basket-prices");
  if (!button) return;
  const explanation = document.querySelector("#comparison-availability");
  const reflectAvailability = () => {
    button.hidden = button.disabled;
    if (explanation) explanation.hidden = !button.disabled;
  };
  reflectAvailability();
  new MutationObserver(reflectAvailability).observe(button, {
    attributes: true, attributeFilter: ["disabled"],
  });
})();
