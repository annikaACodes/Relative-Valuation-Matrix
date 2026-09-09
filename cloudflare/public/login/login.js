const form = document.querySelector("#login-form");
const codeInput = document.querySelector("#access-code");
const status = document.querySelector("#form-status");
const submitButton = form.querySelector("button[type='submit']");

function readCookie(name) {
  const prefix = `${name}=`;
  for (const field of document.cookie.split(";")) {
    const value = field.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return "";
}

function destination() {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "";

  if (!form.reportValidity()) return;
  const csrfToken = readCookie("__Host-rvm_csrf");
  if (!csrfToken) {
    status.textContent = "The secure sign-in token is unavailable. Reload this page and try again.";
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Checking";

  try {
    const response = await fetch("/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({ code: codeInput.value, next: destination() })
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 401) throw new Error("That access code is not valid.");
      if (response.status === 429) throw new Error("Too many attempts. Wait one minute and try again.");
      if (response.status === 403) throw new Error("The secure sign-in token expired. Reload this page and try again.");
      throw new Error("Sign-in is temporarily unavailable. Try again later.");
    }

    window.location.assign(result.redirect || "/");
  } catch (error) {
    codeInput.value = "";
    codeInput.focus();
    status.textContent = error instanceof Error ? error.message : "Sign-in failed. Try again.";
    submitButton.disabled = false;
    submitButton.textContent = "Continue";
  }
});
