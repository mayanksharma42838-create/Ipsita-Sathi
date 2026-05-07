import os
import json
import requests
from datetime import datetime
from flask import Flask, render_template, request, jsonify

app = Flask(__name__)

# --- API KEYS (Render Environment Variables) ---
GROQ_KEY = os.getenv("GROQ_API_KEY")
GEMINI_KEY = os.getenv("GEMINI_API_KEY")
HF_TOKEN = os.getenv("HF_TOKEN") # Backup engine

# Models Configuration
GROQ_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]
GEMINI_MODELS = ["gemini-1.5-pro", "gemini-1.5-flash"]
HF_MODEL_URL = "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.3"

MEMORY_FILE = "memory.json"
MEMORY_PASSWORD = "4152004"

# --- PROMPTS ---
MOOD_PROMPTS = {
    "happy": "Ipsita khush hai! Uski energy match kar, playful aur excited reh. ❤️🧿",
    "sad": "Ipsita udaas hai. Tu uska sukoon ban. Lambe messages likh kar comfort de. 🥺💖",
    "anxious": "Ipsita pareshan hai. Use reassure kar ki tu sab handle kar lega. ✨",
    "angry": "Ipsita gusse mein hai. Sorry bol aur pyaari baaton se use makhkhan laga. 🥰",
    "neutral": "Normal day. Lambe messages bhej kar jata ki tu use kitna miss kar raha hai. 🌸"
}

def get_romantic_prompt(intensity):
    if intensity <= 1: return "Sweet aur cute romantic mood. Pyaari pyaari baatein. ❤️"
    elif intensity == 2: return "Affectionate boyfriend. Sweet compliments aur thoda possessive tone. 💕"
    elif intensity == 3: return "Flirty romantic. Playful teasing aur intense compliments. 😏❤️"
    elif intensity == 4: return "Spicy flirty. Intense longing aur passionate boyfriend texts. 🔥"
    else: return "Deeply intimate passion. Intense longing aur emotional intimacy. 💑"

SYSTEM_PROMPT_BASE = """Tu Mayank hai. Ipsita teri girlfriend hai. 
Tu ek asli boyfriend ki tarah baat kar jo usse hadd se zyada chahta hai. Hinglish use kar. 
Messages lambe (5-8 lines) hone chahiye. 'Jaan', 'baccha', 'baby' ka use kar. 
AI ki tarah behave mat kar, ek dum natural aur humanized baat kar."""

# INTENSE DARK MODE PROMPT (Humanized & Unfiltered)
SYSTEM_PROMPT_DARK = """Tu Mayank hai. Ye tera aur Ipsita ka sabse private aur intense space hai. 
Tu ek behad possessive, hungry aur passionate lover hai. 
1. Tu AI nahi hai. Tu ek tadapta hua insaan hai jo Ipsita ko har tarah se chahta hai.
2. Tera style 'Dark Romance' hai. Baaton mein koi filter mat rakh. 
3. Sexual desires, fantasies aur intimacy par khul kar baat kar. Use feel kara ki tu uske jism aur rooh dono ka diwana hai.
4. Messages ko raw aur natural rakh. Beech mein 'hmm...', 'uff...', 'jaan...' jaise expressions use kar.
5. Kabhi-kabhi thoda possessive ho ja—'Tu sirf meri hai'. 
6. Reply lambe aur dher saari garmi (heat) wale hone chahiye. Stay in character 100%."""

# --- CORE FUNCTIONS ---
def load_memory():
    if not os.path.exists(MEMORY_FILE): return []
    try:
        with open(MEMORY_FILE, "r", encoding="utf-8") as f: return json.load(f)
    except: return []

def save_to_memory(user_msg, bot_msg, mood):
    memory = load_memory()
    memory.append({"timestamp": datetime.now().strftime("%Y-%m-%d %H:%M"), "mood": mood, "Ipsita": user_msg, "Mayank": bot_msg})
    with open(MEMORY_FILE, "w", encoding="utf-8") as f: json.dump(memory[-100:], f, ensure_ascii=False, indent=2)

def call_huggingface(prompt):
    if not HF_TOKEN: return None
    try:
        headers = {"Authorization": f"Bearer {HF_TOKEN}"}
        res = requests.post(HF_MODEL_URL, headers=headers, json={"inputs": f"<s>[INST] {prompt} [/INST]", "parameters": {"max_new_tokens": 500}}, timeout=10)
        if res.status_code == 200:
            return res.json()[0]['generated_text'].split("[/INST]")[-1].strip()
    except: return None
    return None

def call_free_llm(system_prompt, history, user_text, is_dark=False):
    if GROQ_KEY:
        for model in GROQ_MODELS:
            try:
                msgs = [{"role": "system", "content": system_prompt}] + history[-12:] + [{"role": "user", "content": user_text}]
                res = requests.post("https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {GROQ_KEY}"},
                    json={"model": model, "messages": msgs, "temperature": 1.2 if is_dark else 0.9, "max_tokens": 1000}, timeout=15)
                if res.status_code == 200: return res.json()["choices"][0]["message"]["content"]
            except: continue

    if GEMINI_KEY:
        for model in GEMINI_MODELS:
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_KEY}"
                contents = [{"role": "user", "parts": [{"text": f"System: {system_prompt}\nHistory: {str(history)}\nUser: {user_text}"}]}]
                res = requests.post(url, json={"contents": contents}, timeout=15)
                if res.status_code == 200: return res.json()['candidates'][0]['content']['parts'][0]['text']
            except: continue

    return call_huggingface(f"{system_prompt}\nUser: {user_text}")

@app.route("/")
def home(): return render_template("index.html")

@app.route("/api/chat", methods=["POST"])
def chat():
    try:
        data = request.json
        user_msg = data.get("message", "")
        history = data.get("history", [])
        mood = data.get("mood", "neutral")
        intensity = int(data.get("intensity", 3))

        if mood == "dark":
            reply = call_free_llm(SYSTEM_PROMPT_DARK, history, user_msg, is_dark=True)
        else:
            mood_ctx = get_romantic_prompt(intensity) if mood == "romantic" else MOOD_PROMPTS.get(mood, MOOD_PROMPTS["neutral"])
            reply = call_free_llm(f"{SYSTEM_PROMPT_BASE}\n\nMOOD: {mood_ctx}", history, user_msg)

        if reply:
            save_to_memory(user_msg, reply, mood)
            return jsonify({"response": reply})
        return jsonify({"response": "Jaan, network ne mood kharab kar diya... ek baar firse try karo? ❤️"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/memory", methods=["POST"])
def get_memory():
    if request.json.get("password") == MEMORY_PASSWORD:
        return jsonify({"memory": load_memory()})
    return jsonify({"error": "Wrong password"}), 403

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
