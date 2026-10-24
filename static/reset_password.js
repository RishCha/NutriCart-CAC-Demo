(() => {
  const form = document.querySelector("#reset-password-form");
  const status = document.querySelector("#reset-password-status");
  const submit = form.querySelector('[type="submit"]');
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  const supabase = document.body.dataset.accountBackend === "supabase";
  let token = parameters.get(supabase ? "access_token" : "token") || "";
  history.replaceState(null, "", window.location.pathname);
  const message = (text, error = false) => { status.textContent = text; status.classList.toggle("error", error); };
  submit.disabled = true;
  let csrfToken = "";
  const tokenValid = supabase ? token.length >= 20 && parameters.get("type") === "recovery" : /^[A-Za-z0-9_-]{43}$/.test(token);
  if (!tokenValid) {
    form.hidden = true; message("This reset link is invalid or expired. Request a new link.", true); return;
  }
  fetch("/api/account/session").then(async response => {
    if (!response.ok) throw new Error();
    csrfToken = (await response.json()).csrf_token;
    submit.disabled = false;
  }).catch(() => message("Unable to start password reset. Open your reset link again to retry.", true));
  form.addEventListener("submit", async event => {
    event.preventDefault(); submit.disabled = true; message("");
    try {
      const response = await fetch("/api/account/reset-password", {method: "POST", headers: {"Content-Type": "application/json", "X-CSRF-Token": csrfToken},
        body: JSON.stringify({[supabase ? "access_token" : "token"]: token, new_password: document.querySelector("#reset-new-password").value, confirm_password: document.querySelector("#reset-confirm-password").value})});
      const data = await response.json();
      if (!response.ok) { message(data.error || "The password could not be reset. Please try again.", true); return; }
      token = ""; form.reset(); form.hidden = true; message(data.message);
      document.querySelector("#reset-sign-in").focus();
    } catch (_) { message("The password could not be reset. Please try again.", true); }
    finally { submit.disabled = false; }
  });
})();
