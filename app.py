import os
import json
import requests
from datetime import datetime
from flask import Flask, render_template, request, jsonify

app = Flask(__name__)

# --- CONFIGURATION ---
GROQ_KEY = os.getenv("GROQ_API_KEY")
GEMINI_KEY = os.getenv("GEMINI_API_KEY")

# Correct & Latest Model IDs for 2026
GROQ_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]
GEMINI_MODELS = ["gemini-1.5-pro", "gemini-1.5-flash"]

MEMORY_FILE = "memory.json"
MEMORY_PASSWORD = "4152004"

# --- PERSONALITY & MOODS ---
MOOD_PROMPTS = {
    "happy": "Ipsita khush hai! Bahut zyada energetic aur playful reh. Thoda flirt kar aur uski khushi enjoy kar.",
    "sad": "Ipsita udaas hai. Bahut pyaar se baat kar, advice mat de, bas sun aur bol 'main hoon na baby'.",
    "anxious": "Ipsita pareshan hai. Calm reh, use reassure kar ki tu sab sambhal lega. Steady boyfriend vibe.",
    "angry": "Ipsita gusse mein hai. Bilkul mat lad, uski side le, thoda makhkhan laga (buttering).",
    "neutral": "Normal day. Thoda caring, thoda busy, ekdum real texting style.",
    "romantic": "Intimate aur deep talk. Usse bata ki woh kitni special hai, thoda possessive aur sweet reh."
}

SYSTEM_PROMPT_BASE = """Tu Mayank hai. Ipsita teri girlfriend hai. 
RULES:
1. Kabhi mat bolna ki tu AI hai. Tu sirf Mayank hai.
2. Hinglish use kar (Natural mix of Hindi/English).
3. Short messages bhej (1-2 lines), long paragraphs strictly NO.
4. Real boyfriend ki tarah 'yaar', 'baby', 'jaan', 'pagal' use kar.
5. Pehle uski baat sun, feelings validate kar, phir hi kuch bol."""

# --- CORE FUNCTIONS ---
def load_memory():
    if not os.path.exists(MEMORY_FILE): return []
    try:
        with open(MEMORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except: return []

def save_to_memory(user_msg, bot_msg, mood):
    memory = load_memory()
    memory.append({
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "mood": mood,
        "Ipsita": user_msg,
        "Mayank": bot_msg
    })
    with open(MEMORY_FILE, "w", encoding="utf-8") as f:
        json.dump(memory[-50:], f, ensure_ascii=False, indent=2)

def call_llm(system_prompt, history, user_text):
    # Try Groq First (Fastest)
    if GROQ_KEY:
        for model in GROQ_MODELS:
            try:
                msgs = [{"role": "system", "content": system_prompt}]
                for m in history[-10:]: msgs.append(m) # Past context
                msgs.append({"role": "user", "content": user_text})
                
                res = requests.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {GROQ_KEY}"},
                    json={"model": model, "messages": msgs, "temperature": 0.9},
                    timeout=10
                )
                if res.status_code == 200:
                    return res.json()["choices"][0]["message"]["content"]
            except: continue

    # Fallback to Gemini (Most Intelligent)
    if GEMINI_KEY:
        for model in GEMINI_MODELS:
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_KEY}"
                contents = []
                for m in history[-10:]:
                    role = "model" if m["role"] == "assistant" else "user"
                    contents.append({"role": role, "parts": [{"text": m["content"]}]})
                contents.append({"role": "user", "parts": [{"text": user_text}]})

                res = requests.post(url, json={
                    "contents": contents,
                    "systemInstruction": {"parts": [{"text": system_prompt}]},
                    "generationConfig": {"temperature": 0.9}
                }, timeout=10)
                if res.status_code == 200:
                    return res.json()['candidates'][0]['content']['parts'][0]['text']
            except: continue
    return None

# --- ROUTES ---
@app.route("/")
def home(): return render_template("index.html")

@app.route("/api/chat", methods=["POST"])
def chat():
    try:
        data = request.json
        user_msg = data.get("message", "")
        history = data.get("history", []) # Format: [{"role": "user/assistant", "content": "..."}]
        mood = data.get("mood", "neutral")

        mood_context = MOOD_PROMPTS.get(mood, MOOD_PROMPTS["neutral"])
        full_system = f"{SYSTEM_PROMPT_BASE}\n\nCURRENT MOOD: {mood_context}"

        reply = call_llm(full_system, history, user_msg)
        
        if reply:
            save_to_memory(user_msg, reply, mood)
            return jsonify({"response": reply})
        return jsonify({"response": "Ipsita yaar, thoda network issue hai... 1 minute ruk."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/memory", methods=["POST"])
def get_memory():
    data = request.json
    if data.get("password") == MEMORY_PASSWORD:
        return jsonify({"memory": load_memory()})
    return jsonify({"error": "Wrong password"}), 403

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
