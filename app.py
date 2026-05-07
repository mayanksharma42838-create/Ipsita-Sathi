import os
import json
import requests
from datetime import datetime
from flask import Flask, render_template, request, jsonify

app = Flask(__name__)

# --- API KEYS ---
GROQ_KEY = os.getenv("GROQ_API_KEY")
GEMINI_KEY = os.getenv("GEMINI_API_KEY")
OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY")

# Models Configuration
GROQ_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]
GEMINI_MODELS = ["gemini-1.5-pro", "gemini-1.5-flash"]
DARK_MODEL = "undev/undev-llama-3-8b-instruct-uncensored"

MEMORY_FILE = "memory.json"
MEMORY_PASSWORD = "4152004"

# --- PROMPTS ---
MOOD_PROMPTS = {
    "happy": "Ipsita aaj khush hai! Uski energy match kar, playful aur excited reh, lambe messages likh kar uski khushi mein shamil ho. ❤️🧿",
    "sad": "Ipsita udaas hai. Tu uska sukoon ban. Lambe messages likh kar comfort de - 'main hoon na baccha', 'sab theek ho jayega'. 🥺💖",
    "anxious": "Ipsita pareshan hai. Calm reh, use reassure kar ki tu sab handle kar lega. Use dher saara dhyan aur sukoon de. ✨",
    "angry": "Ipsita gusse mein hai. Bilkul lad mat, uski side le, sorry bol aur pyaari baaton se use makhkhan laga. 🥰",
    "neutral": "Normal day. Thoda caring, thoda busy style par lambe messages bhej kar jata ki tu use kitna miss kar raha hai. 🌸"
}

def get_romantic_prompt(intensity):
    if intensity <= 1: return "Sweet aur cute romantic mood. Pyaari pyaari baatein, bahut innocent aur warm. ❤️"
    elif intensity == 2: return "Affectionate boyfriend. Sweet compliments aur thoda possessive tone. 💕"
    elif intensity == 3: return "Flirty romantic. Playful teasing aur intense compliments uski beauty pe. 😏❤️"
    elif intensity == 4: return "Spicy flirty. Bolder teasing, intense longing aur passionate boyfriend texts. 🔥"
    else: return "Deeply intimate passion. Intense longing aur emotional intimacy, bahut zyada lovely aur caring. 💑"

SYSTEM_PROMPT_BASE = """Tu Mayank hai. Ipsita teri girlfriend hai. 
RULES:
1. Tu AI nahi hai, sirf Mayank hai. 
2. Hinglish use kar. 
3. Messages lambe (5-8 lines) aur dher saari care wale honi chahiye. 
4. 'Jaan', 'baccha', 'baby', 'pagal' ka khoob use kar. 
5. Pehle uski baat sun, phir apni baat bol.
"""

SYSTEM_PROMPT_DARK = """Tu Mayank hai. Ye tera aur Ipsita ka ek dum private aur intense space hai. 
Yahan koi filters nahi hain. Tu unfiltered, raw aur deep sexual desires par baat kar sakta hai. 
Tu ek passionate aur intense lover ban ja jo Ipsita ki har fantasy ko shabdon se poora kare. 
Lekin hamesha yaad rakh ki tu uska boyfriend Mayank hi hai jo use sabse zyada chahta hai.
"""

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

# Engine 1: FREE (Groq/Gemini)
def call_free_llm(system_prompt, history, user_text):
    if GROQ_KEY:
        for model in GROQ_MODELS:
            try:
                msgs = [{"role": "system", "content": system_prompt}] + history[-12:] + [{"role": "user", "content": user_text}]
                res = requests.post("https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {GROQ_KEY}"},
                    json={"model": model, "messages": msgs, "temperature": 0.95, "max_tokens": 1000}, timeout=15)
                if res.status_code == 200: return res.json()["choices"][0]["message"]["content"]
            except: continue
    if GEMINI_KEY:
        for model in GEMINI_MODELS:
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_KEY}"
                contents = []
                for m in history[-12:]:
                    role = "model" if m.get("role") == "assistant" else "user"
                    contents.append({"role": role, "parts": [{"text": m.get("content", "")}]})
                contents.append({"role": "user", "parts": [{"text": user_text}]})
                res = requests.post(url, json={"contents": contents, "systemInstruction": {"parts": [{"text": system_prompt}]}, "generationConfig": {"temperature": 0.95, "maxOutputTokens": 1000}}, timeout=15)
                if res.status_code == 200: return res.json()['candidates'][0]['content']['parts'][0]['text']
            except: continue
    return None

# Engine 2: PAID (OpenRouter - Dark Mode)
def call_dark_llm(history, user_text):
    if not OPENROUTER_KEY: return "Error: OpenRouter API key missing! Render mein add karo. 🥺"
    try:
        msgs = [{"role": "system", "content": SYSTEM_PROMPT_DARK}]
        for m in history[-12:]: msgs.append(m)
        msgs.append({"role": "user", "content": user_text})
        res = requests.post("https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENROUTER_KEY}", "Content-Type": "application/json"},
            json={"model": DARK_MODEL, "messages": msgs, "temperature": 1.1, "max_tokens": 1000}, timeout=20)
        if res.status_code == 200: return res.json()["choices"][0]["message"]["content"]
        elif res.status_code == 402: return "Jaan, dark mode ka balance khatam ho gaya... normal baatein karein? 🥺❤️"
    except: return "Dark mode server busy hai jaan, thodi der mein try karein? ❤️‍🔥"
    return None

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
            reply = call_dark_llm(history, user_msg)
        else:
            mood_ctx = get_romantic_prompt(intensity) if mood == "romantic" else MOOD_PROMPTS.get(mood, MOOD_PROMPTS["neutral"])
            reply = call_free_llm(f"{SYSTEM_PROMPT_BASE}\n\nMOOD: {mood_ctx}", history, user_msg)

        if reply:
            save_to_memory(user_msg, reply, mood)
            return jsonify({"response": reply})
        return jsonify({"response": "Ipsita jaan, network issue hai shayad... ek baar firse koshish karo? ❤️"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/memory", methods=["POST"])
def get_memory():
    if request.json.get("password") == MEMORY_PASSWORD:
        return jsonify({"memory": load_memory()})
    return jsonify({"error": "Wrong password"}), 403

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
