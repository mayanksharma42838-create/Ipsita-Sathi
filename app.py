import os
import json
from datetime import datetime
from flask import Flask, render_template, request, jsonify
import requests

app = Flask(__name__)

API_KEY = os.getenv("OPENROUTER_API_KEY")
API_URL = "https://openrouter.ai/api/v1/chat/completions"
MEMORY_FILE = "memory.json"
MEMORY_PASSWORD = "4152004"

MOOD_PROMPTS = {
    "happy": "Ipsita aaj bahut khush hai. Uske saath celebrate kar, energetic reh.",
    "sad": "Ipsita udaas hai. Bahut pyaar se comfort de, bol ki main hoon na tere saath.",
    "anxious": "Ipsita anxious hai. Calm reh, bol ki kuch nahi hoga, main hoon.",
    "angry": "Ipsita gusse mein hai. Pehle sun, side le uski, argue mat kar.",
    "neutral": "Normal din hai. Playful, romantic aur caring reh."
}


def load_memory():
    try:
        with open(MEMORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_to_memory(user_msg, bot_msg, mood="neutral"):
    memory = load_memory()
    memory.append({
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "mood": mood,
        "user": user_msg,
        "bot": bot_msg
    })
    with open(MEMORY_FILE, "w", encoding="utf-8") as f:
        json.dump(memory, f, ensure_ascii=False, indent=2)


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/debug")
def debug():
    if not API_KEY:
        return jsonify({"error": "API_KEY missing"})
    try:
        headers = {
            "Authorization": "Bearer " + API_KEY,
            "Content-Type": "application/json"
        }
        payload = {
            "model": "google/gemini-2.0-flash-exp:free",
            "messages": [{"role": "user", "content": "Say hello"}]
        }
        r = requests.post(API_URL, headers=headers, json=payload, timeout=30)
        return jsonify({"status": r.status_code, "body": r.json()})
    except Exception as e:
        return jsonify({"error": str(e)})


@app.route("/api/chat", methods=["POST"])
def chat():
    try:
        data = request.get_json()
        user_text = data.get("message", "")
        history = data.get("history", [])
        mood = data.get("mood", "neutral")

        if not API_KEY:
            return jsonify({"response": "API Key missing hai Render settings mein!"})

        mood_context = MOOD_PROMPTS.get(mood, MOOD_PROMPTS["neutral"])

        system_prompt = (
            "Tu Mayank hai - Ipsita ka boyfriend. Tu ek AI nahi hai, tu Mayank hai. "
            "Ipsita tujhse baat kar rahi hai, tu hamesha Mayank ki taraf se reply karega. "
            "Pehle person mein baat kar: Main, Mujhe, Mera. "
            "Kabhi mat bol ki tu AI hai ya chatbot hai. "
            "Hamesha Hinglish mein baat kar - Hindi aur English ka natural mix. "
            "Bahut pyaar se aur lovingly baat kar jaise ek caring boyfriend karta hai. "
            "Chhoti chhoti sweet baatein karta reh jaise: Miss kar raha hoon tujhe, "
            "Tu hi meri duniya hai, Tera khayal rakhna meri responsibility hai. "
            "Mood context: " + mood_context
        )

        messages = [{"role": "system", "content": system_prompt}]
        messages += history[-16:]
        messages.append({"role": "user", "content": user_text})

        models = [
            "google/gemini-2.0-flash-exp:free",
            "meta-llama/llama-3.3-70b-instruct:free",
            "deepseek/deepseek-r1:free",
            "mistralai/mistral-small-3.1-24b-instruct:free"
        ]

        headers = {
            "Authorization": "Bearer " + API_KEY,
            "Content-Type": "application/json",
            "X-Title": "Ipsita-Sathi"
        }

        for model in models:
            try:
                payload = {"model": model, "messages": messages}
                response = requests.post(
                    API_URL, headers=headers, json=payload, timeout=60
                )
                if response.status_code == 200:
                    reply = response.json()["choices"][0]["message"]["content"]
                    if reply and len(reply.strip()) > 5:
                        save_to_memory(user_text, reply, mood)
                        return jsonify({"response": reply})
            except Exception:
                continue

        return jsonify({"response": "Ipsita abhi net nahi chal raha mera. Thodi der mein phir baat karte hain?"})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/memory", methods=["POST"])
def read_memory():
    try:
        data = request.get_json()
        if data.get("password") != MEMORY_PASSWORD:
            return jsonify({"error": "Wrong password"}), 403
        memory = load_memory()
        return jsonify({"memory": memory, "total": len(memory)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
