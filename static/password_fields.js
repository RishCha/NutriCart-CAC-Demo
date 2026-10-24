(() => {
  const requirementMessage = "Use at least 10 characters and include both letters and numbers.";

  function meetsRequirements(value) {
    return typeof value === "string"
      && value.length >= 10
      && /[A-Za-z]/.test(value)
      && /[0-9]/.test(value)
      && !/^(.)\1+$/u.test(value);
  }

  function strength(value) {
    if (!value) return "";
    if (!meetsRequirements(value)) return "Needs at least 10 characters with letters and numbers.";
    const variety = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(pattern => pattern.test(value)).length;
    return value.length >= 16 || (value.length >= 12 && variety >= 3)
      ? "Strong password."
      : "Meets requirements. A longer phrase is stronger.";
  }

  document.querySelectorAll("[data-password-strength]").forEach(output => {
    const input = document.getElementById(output.dataset.passwordStrength);
    const update = () => {
      const label = strength(input.value);
      output.textContent = label;
      output.dataset.strength = !input.value ? "" : !meetsRequirements(input.value) ? "weak" : label === "Strong password." ? "strong" : "fair";
      input.setCustomValidity(input.value && !meetsRequirements(input.value) ? requirementMessage : "");
    };
    input.addEventListener("input", update);
    input.form?.addEventListener("reset", () => setTimeout(update, 0));
    update();
  });

  document.querySelectorAll("[data-confirm-password]").forEach(confirm => {
    const password = document.getElementById(confirm.dataset.confirmPassword);
    const validate = () => confirm.setCustomValidity(confirm.value && confirm.value !== password.value ? "Passwords do not match." : "");
    confirm.addEventListener("input", validate); password.addEventListener("input", validate);
    confirm.form?.addEventListener("reset", () => setTimeout(validate, 0));
  });

  document.querySelectorAll(".password-toggle").forEach(button => {
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      const input = button.parentElement.querySelector("input");
      input.type = input.type === "password" ? "text" : "password";
      const action = input.type === "password" ? "Show" : "Hide";
      button.textContent = action;
      button.setAttribute("aria-label", button.getAttribute("aria-label").replace(/^(Show|Hide)/, action));
      button.setAttribute("aria-pressed", String(input.type === "text"));
    });
  });

  window.NutriCartPasswords = Object.freeze({strength, meetsRequirements, requirementMessage});
})();
