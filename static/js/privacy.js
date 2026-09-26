/** Screenshot / capture discouragement (best-effort on web). */
const PrivacyGuard = (() => {
  function init() {
    // Block common copy/export shortcuts for chat area
    document.addEventListener("keydown", (e) => {
      const blocked =
        (e.ctrlKey || e.metaKey) &&
        ["s", "p", "u"].includes(e.key.toLowerCase());
      const printScreen = e.key === "PrintScreen";
      if (blocked || printScreen) {
        e.preventDefault();
        flashCaptureGuard();
      }
    });

    document.addEventListener("contextmenu", (e) => {
      if (e.target.closest("#messages, #doodleCanvas")) {
        e.preventDefault();
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        document.body.classList.add("privacy-blur");
      } else {
        document.body.classList.remove("privacy-blur");
      }
    });

    window.addEventListener("blur", () => document.body.classList.add("privacy-blur"));
    window.addEventListener("focus", () => document.body.classList.remove("privacy-blur"));

    // Disable drag of media
    document.addEventListener("dragstart", (e) => {
      if (e.target.closest("#messages")) e.preventDefault();
    });
  }

  function flashCaptureGuard() {
    document.body.classList.add("capture-guard");
    setTimeout(() => document.body.classList.remove("capture-guard"), 800);
  }

  return { init, flashCaptureGuard };
})();
