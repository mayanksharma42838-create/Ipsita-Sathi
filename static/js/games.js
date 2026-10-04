/**
 * Couple Games Section Controller for Ipsita-Sathi
 * Includes Overcooked! Style Co-op Mini-Game, Candy Crush Match-3, and Co-Op Game Hub
 */

(function () {
  "use strict";

  let gameSocket = null;
  let memberId = null;
  let activeTab = "hub";

  // ─── Overcooked Mini-Game State ───
  let ocCanvas = null;
  let ocCtx = null;
  let ocScore = 0;
  let ocTime = 120;
  let ocTimerInterval = null;
  let ocKitchen = {
    chopStation: null,
    chopProgress: 0,
    grillStation: null,
    grillProgress: 0,
    assembly: [],
    currentOrder: { name: "Cheeseburger", recipe: ["bun", "cooked_patty", "cheese"], points: 100 },
  };

  // ─── Candy Crush Match-3 State ───
  let ccCanvas = null;
  let ccCtx = null;
  let ccScore = 0;
  const CC_ROWS = 7;
  const CC_COLS = 7;
  const CANDY_TYPES = ["🔴", "💙", "💚", "💛", "💜"];
  let ccBoard = [];
  let ccSelected = null;

  function initGames(socket, currentMemberId) {
    gameSocket = socket;
    memberId = currentMemberId;

    bindGameTabEvents();
    initOvercookedCanvas();
    initCandyCrushCanvas();

    if (gameSocket) {
      gameSocket.on("game_action", handleRemoteGameAction);
      gameSocket.on("game_score_update", handleRemoteScoreUpdate);
    }
  }

  function bindGameTabEvents() {
    const tabs = document.querySelectorAll(".game-tab-btn");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        showGameView(tab.dataset.tab);
      });
    });

    const btnShareCode = document.getElementById("btnShareGameCode");
    if (btnShareCode) {
      btnShareCode.addEventListener("click", () => {
        const code = document.getElementById("gameCodeInput")?.value || "";
        if (code && window.AppSendMessage) {
          window.AppSendMessage(`🎮 Join my Co-Op session! Room Code / Link: ${code}`);
          alert("Co-op room link shared to partner!");
        }
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 1. OVERCOOKED STYLE CO-OP MINI-GAME
  // ─────────────────────────────────────────────────────────────

  function initOvercookedCanvas() {
    ocCanvas = document.getElementById("overcookedCanvas");
    if (!ocCanvas) return;
    ocCtx = ocCanvas.getContext("2d");

    ocCanvas.addEventListener("click", handleOvercookedClick);

    const btnChop = document.getElementById("btnOcChop");
    const btnGrill = document.getElementById("btnOcGrill");
    const btnServe = document.getElementById("btnOcServe");
    const btnReset = document.getElementById("btnOcReset");

    if (btnChop) btnChop.onclick = () => doOvercookedAction("chop");
    if (btnGrill) btnGrill.onclick = () => doOvercookedAction("grill");
    if (btnServe) btnServe.onclick = () => doOvercookedAction("serve");
    if (btnReset) btnReset.onclick = () => resetOvercooked(true);
  }

  function resetOvercooked(broadcast = false) {
    ocScore = 0;
    ocTime = 120;
    ocKitchen = {
      chopStation: "lettuce",
      chopProgress: 0,
      grillStation: "raw_patty",
      grillProgress: 0,
      assembly: ["bun"],
      currentOrder: { name: "Cheeseburger", recipe: ["bun", "cooked_patty", "cheese"], points: 100 },
    };

    updateOcUi();
    drawOvercookedCanvas();

    if (ocTimerInterval) clearInterval(ocTimerInterval);
    ocTimerInterval = setInterval(() => {
      if (ocTime > 0) {
        ocTime--;
        const timeEl = document.getElementById("ocTimeDisplay");
        if (timeEl) timeEl.textContent = `${ocTime}s`;
      } else {
        clearInterval(ocTimerInterval);
        alert(`⏱️ Kitchen Time's Up! Final Co-Op Score: ${ocScore}`);
      }
    }, 1000);

    if (broadcast && gameSocket) {
      gameSocket.emit("game_action", { game: "overcooked", type: "reset" });
    }
  }

  function doOvercookedAction(actionType) {
    if (actionType === "chop") {
      if (ocKitchen.chopStation) {
        ocKitchen.chopProgress += 34;
        if (ocKitchen.chopProgress >= 100) {
          const choppedItem = "chopped_" + ocKitchen.chopStation;
          ocKitchen.assembly.push(choppedItem);
          ocKitchen.chopStation = null;
          ocKitchen.chopProgress = 0;
        }
      } else {
        ocKitchen.chopStation = "lettuce";
        ocKitchen.chopProgress = 0;
      }
    } else if (actionType === "grill") {
      if (ocKitchen.grillStation === "raw_patty") {
        ocKitchen.grillProgress += 50;
        if (ocKitchen.grillProgress >= 100) {
          ocKitchen.assembly.push("cooked_patty");
          ocKitchen.grillStation = null;
          ocKitchen.grillProgress = 0;
        }
      } else {
        ocKitchen.grillStation = "raw_patty";
        ocKitchen.grillProgress = 0;
      }
    } else if (actionType === "serve") {
      ocKitchen.assembly.push("cheese");
      ocScore += ocKitchen.currentOrder.points;
      alert(`🍔 Order Served! +${ocKitchen.currentOrder.points} pts`);
      ocKitchen.assembly = ["bun"];
      ocKitchen.currentOrder = { name: "Salad Burger", recipe: ["bun", "cooked_patty", "chopped_lettuce"], points: 120 };
    }

    updateOcUi();
    drawOvercookedCanvas();

    if (gameSocket) {
      gameSocket.emit("game_action", {
        game: "overcooked",
        type: "action",
        kitchen: ocKitchen,
  function updateOcUi() {
    const scoreEl = document.getElementById("ocScoreDisplay");
    const orderEl = document.getElementById("ocOrderDisplay");
    const assemblyEl = document.getElementById("ocAssemblyDisplay");

    if (scoreEl) scoreEl.textContent = ocScore;
    if (orderEl) orderEl.textContent = `${ocKitchen.currentOrder.name} (${ocKitchen.currentOrder.recipe.join(" + ")})`;
    if (assemblyEl) assemblyEl.textContent = ocKitchen.assembly.join(", ") || "Plate Empty";
  }

  function drawOvercookedCanvas() {
    if (!ocCtx || !ocCanvas) return;
    const w = ocCanvas.width;
    const h = ocCanvas.height;

    ocCtx.clearRect(0, 0, w, h);

    // Kitchen Floor
    ocCtx.fillStyle = "#1e293b";
    ocCtx.fillRect(0, 0, w, h);

    // Grid Counters
    ocCtx.fillStyle = "#334155";
    ocCtx.fillRect(20, 20, 100, 100);
    ocCtx.fillRect(140, 20, 100, 100);
    ocCtx.fillRect(260, 20, 120, 100);

    // Counter Labels
    ocCtx.fillStyle = "#ff8fab";
    ocCtx.font = "bold 12px Nunito, sans-serif";
    ocCtx.textAlign = "center";
    ocCtx.fillText("🔪 Chop Station", 70, 40);
    ocCtx.fillText("🔥 Grill Station", 190, 40);
    ocCtx.fillText("🍽️ Plate Counter", 320, 40);

    if (ocKitchen.chopStation) {
      ocCtx.fillStyle = "#10b981";
      ocCtx.fillRect(30, 80, ocKitchen.chopProgress * 0.8, 12);
      ocCtx.fillStyle = "#fff";
      ocCtx.fillText(ocKitchen.chopStation, 70, 70);
    }

    if (ocKitchen.grillStation) {
      ocCtx.fillStyle = "#f59e0b";
      ocCtx.fillRect(150, 80, ocKitchen.grillProgress * 0.8, 12);
      ocCtx.fillStyle = "#fff";
      ocCtx.fillText(ocKitchen.grillStation, 190, 70);
    }

    ocCtx.fillStyle = "#cbd5e1";
    ocCtx.fillText(ocKitchen.assembly.join(" + "), 320, 75);
  }

  function handleOvercookedClick(e) {
    const rect = ocCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < 120) doOvercookedAction("chop");
    else if (x < 240) doOvercookedAction("grill");
    else doOvercookedAction("serve");
  }

  // ─────────────────────────────────────────────────────────────
  // 2. CANDY CRUSH MATCH-3 HTML5 PUZZLE
  // ─────────────────────────────────────────────────────────────

  function initCandyCrushCanvas() {
    ccCanvas = document.getElementById("candyCrushCanvas");
    if (!ccCanvas) return;
    ccCtx = ccCanvas.getContext("2d");

    ccCanvas.addEventListener("click", handleCandyCrushClick);
    const btnResetCc = document.getElementById("btnCcReset");
    if (btnResetCc) btnResetCc.onclick = () => resetCandyCrush(true);
  }

  function resetCandyCrush(broadcast = false) {
    ccScore = 0;
    ccSelected = null;
    ccBoard = [];

    for (let r = 0; r < CC_ROWS; r++) {
      const row = [];
      for (let c = 0; c < CC_COLS; c++) {
        row.push(CANDY_TYPES[Math.floor(Math.random() * CANDY_TYPES.length)]);
      }
      ccBoard.push(row);
    }

    updateCcUi();
    drawCandyCrushCanvas();

    if (broadcast && gameSocket) {
      gameSocket.emit("game_action", { game: "candycrush", type: "reset" });
    }
  }

  function drawCandyCrushCanvas() {
    if (!ccCtx || !ccCanvas) return;
    const w = ccCanvas.width;
    const h = ccCanvas.height;
    const cellW = w / CC_COLS;
    const cellH = h / CC_ROWS;

    ccCtx.clearRect(0, 0, w, h);
    ccCtx.fillStyle = "#0f172a";
    ccCtx.fillRect(0, 0, w, h);

    for (let r = 0; r < CC_ROWS; r++) {
      for (let c = 0; c < CC_COLS; c++) {
        const x = c * cellW;
        const y = r * cellH;

        ccCtx.strokeStyle = "rgba(255, 143, 171, 0.15)";
        ccCtx.strokeRect(x, y, cellW, cellH);

        if (ccSelected && ccSelected.r === r && ccSelected.c === c) {
          ccCtx.fillStyle = "rgba(255, 143, 171, 0.3)";
          ccCtx.fillRect(x + 2, y + 2, cellW - 4, cellH - 4);
        }

        ccCtx.font = "22px sans-serif";
        ccCtx.textAlign = "center";
        ccCtx.textBaseline = "middle";
        ccCtx.fillText(ccBoard[r][c], x + cellW / 2, y + cellH / 2);
      }
    }
  }

  function handleCandyCrushClick(e) {
    const rect = ccCanvas.getBoundingClientRect();
    const c = Math.floor((e.clientX - rect.left) / (ccCanvas.width / CC_COLS));
    const r = Math.floor((e.clientY - rect.top) / (ccCanvas.height / CC_ROWS));

    if (c < 0 || c >= CC_COLS || r < 0 || r >= CC_ROWS) return;

    if (!ccSelected) {
      ccSelected = { r, c };
    } else {
      const dr = Math.abs(ccSelected.r - r);
      const dc = Math.abs(ccSelected.c - c);
      if ((dr === 1 && dc === 0) || (dr === 0 && dc === 1)) {
        const temp = ccBoard[r][c];
        ccBoard[r][c] = ccBoard[ccSelected.r][ccSelected.c];
        ccBoard[ccSelected.r][ccSelected.c] = temp;

        ccScore += 60;
        updateCcUi();

        if (gameSocket) {
          gameSocket.emit("game_score_update", {
            game: "candycrush",
            score: ccScore,
            msg: `🍬 Candy Match! Score: ${ccScore}`,
          });
        }
      }
      ccSelected = null;
    }

    drawCandyCrushCanvas();
  }

  function updateCcUi() {
    const scoreEl = document.getElementById("ccScoreDisplay");
    if (scoreEl) scoreEl.textContent = ccScore;
  }

  // ─────────────────────────────────────────────────────────────
  // SOCKET SYNC LISTENERS
  // ─────────────────────────────────────────────────────────────

  function handleRemoteGameAction(data) {
    if (!data) return;
    if (data.game === "overcooked") {
      if (data.kitchen) ocKitchen = data.kitchen;
      if (data.score !== undefined) ocScore = data.score;
      updateOcUi();
      drawOvercookedCanvas();
    } else if (data.game === "candycrush" && data.type === "reset") {
      resetCandyCrush(false);
    }
  }

  function handleRemoteScoreUpdate(data) {
    if (!data) return;
    if (data.msg && window.showWaNotification) {
      window.showWaNotification("Partner", data.msg);
    }
  }

  window.CoupleGames = {
    init: initGames,
    showGameView: showGameView,
  };
})();
        score: ocScore,
      });
    }
  }
  function showGameView(tabName) {
    activeTab = tabName;
    const views = document.querySelectorAll(".game-view");
    views.forEach((v) => v.classList.add("hidden"));

    const target = document.getElementById(`gameView-${tabName}`);
    if (target) target.classList.remove("hidden");

    if (tabName === "overcooked") {
      resetOvercooked();
    } else if (tabName === "candycrush") {
      resetCandyCrush();
    }
  }