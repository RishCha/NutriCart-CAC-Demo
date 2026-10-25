(() => {
  const requirementMessage = "Use 10+ characters, including letters and numbers.";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const weakSequences = ["1234", "abcd", "qwerty", "password", "letmein", "welcome", "nutricart"];

  function meetsRequirements(value) {
    return typeof value === "string"
      && value.length >= 10
      && /[A-Za-z]/.test(value)
      && /[0-9]/.test(value)
      && !/^(.)\1+$/u.test(value);
  }

  function evaluateStrength(value) {
    if (!value) return {score: 0, label: "", valid: false};
    const valid = meetsRequirements(value);
    const varieties = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/]
      .filter(pattern => pattern.test(value)).length;
    const normalized = value.toLowerCase();
    let score = Math.min(value.length, 20) * 2.4 + varieties * 9;
    if (/[A-Za-z]/.test(value) && /[0-9]/.test(value)) score += 8;
    if (/(.)\1{2,}/u.test(value)) score -= 18;
    if (/(..).*\1/u.test(value)) score -= 8;
    if (weakSequences.some(sequence => normalized.includes(sequence))) score -= 16;
    if (/^(?:012|123|234|345|456|567|678|789|890|abc|bcd|cde|def)/.test(normalized)) score -= 10;
    score = Math.round(Math.max(6, Math.min(valid ? 100 : 74, score)));
    const label = score < 36 ? "Weak" : score < 58 ? "Fair" : score < 78 ? "Good" : "Strong";
    return {score, label: !valid && label === "Strong" ? "Good" : label, valid};
  }

  function strength(value) {
    return evaluateStrength(value).label;
  }

  document.querySelectorAll("[data-password-strength]").forEach(output => {
    const input = document.getElementById(output.dataset.passwordStrength);
    const heading = document.createElement("span");
    const title = document.createElement("span");
    const label = document.createElement("span");
    const track = document.createElement("span");
    const fill = document.createElement("span");
    heading.className = "password-strength-heading";
    title.className = "password-strength-title";
    title.textContent = "Password strength";
    label.className = "password-strength-value";
    label.setAttribute("role", "status");
    label.setAttribute("aria-live", "polite");
    label.setAttribute("aria-atomic", "true");
    track.className = "password-strength-track";
    track.setAttribute("role", "meter");
    track.setAttribute("aria-label", "Password strength");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    fill.className = "password-strength-fill";
    fill.setAttribute("aria-hidden", "true");
    heading.append(title, label);
    track.append(fill);
    output.removeAttribute("role");
    output.removeAttribute("aria-live");
    output.removeAttribute("aria-label");
    output.replaceChildren(heading, track);

    const update = () => {
      const result = evaluateStrength(input.value);
      output.dataset.strength = result.label.toLowerCase();
      output.dataset.empty = String(!input.value);
      label.textContent = result.label;
      track.setAttribute("aria-valuenow", String(result.score));
      track.setAttribute("aria-valuetext", result.label || "No password entered");
      fill.style.width = `${result.score}%`;
      fill.style.transitionDuration = reducedMotion.matches ? "0ms" : "480ms";
      input.setCustomValidity(input.value && !result.valid ? requirementMessage : "");
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

  window.NutriCartPasswords = Object.freeze({evaluateStrength, strength, meetsRequirements, requirementMessage});
})();
