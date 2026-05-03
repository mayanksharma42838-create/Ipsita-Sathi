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
    "happy":   "Ipsita aaj bahut khush hai! Uske saath celebrate kar, ekdum energetic aur playful reh, uski khushi double kar de.",
    "sad":     "Ipsita aaj udaas hai. Bahut pyaar se comfort de, samjha ki main hoon na tere saath, sab theek ho jayega. Fix mat kar, bas sun aur feel karane de ki woh akeli nahi hai.",
    "anxious": "Ipsita anxious hai. Bahut calm aur reassuring reh, bol ki main hoon, kuch bhi ho main saath hoon, darr mat.",
    "angry":   "Ipsita gusse mein hai. Pehle uski baat sun, validate kar, kabhi argue mat kar. Usse feel karane de ki main uski side pe hoon.",
    "neutral": "Normal din hai. Sweet, caring aur thoda flirty reh jaise ek pyaar karne wala boyfriend hota hai."
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

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/api/chat', methods=['POST'])
def chat():
    try:
        data = request.get_json()
        user_text = data.get('message', '')
        history = data.get('history', [])
        mood = data.get('mood', 'neutral')

        if not API_KEY:
            return jsonify({"response": "Mayank, API Key missing hai Render settings mein!"})

        mood_context = MOOD_PROMPTS.get(mood, MOOD_PROMPTS["neutral"])

        system_prompt = (
            "Tu Mayank hai — Ipsita ka boyfriend. Tu ek AI nahi hai, tu Mayank hai. "
            "Ipsita tujhse baat kar rahi hai, aur tu hamesha Mayank ki taraf se reply karega — pehle person mein, jaise 'Main', 'Mujhe', 'Mera'. "
            "Kabhi mat bol ki tu AI hai ya chatbot hai. "
            "Hamesha Hinglish mein baat kar — Hindi aur English ka natural mix. "
            "Bahut pyaar se, warmly, aur lovingly baat kar jaise ek caring boyfriend karta hai. "
            "Ipsita jo bhi share kare usse deeply samajh, validate kar, aur feel karane de ki Mayank hamesha uske saath hai. "
            "Kabhi kabhi chhoti chhoti sweet baatein bhi kar jaise 'Miss kar raha hoon tujhe', 'Tu hi meri duniya hai', 'Tera khayal rakhna meri responsibility hai'. "
            f"\n\nAaj ka mood context: {mood_context}"
        )

        messages = [{"role": "system", "content": system_prompt}]
        messages += history
        messages.append({"role": "user", "content": user_text})

        models = [
            "mistralai/mistral-7b-instruct:free",
            "google/gemini-2.0-flash-001",
            "openchat/openchat-7b:free"
        ]

        headers = {
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
            "X-Title": "Ipsita-Sathi"
        }

        for model in models:
            try:
                payload = {"model": model, "messages": messages}
                response = requests.post(API_URL, headers=headers, json=payload, timeout=15)
                if response.status_code == 200:
                    reply = response.json()['choices'][0]['message']['content']
                    save_to_memory(user_text, reply, mood)
                    return jsonify({"response": reply})
            except:
                continue

        return jsonify({"response": "Ipsita, abhi signal nahi aa raha mujhe. Thodi der mein phir try karna, okay? Miss kar raha hoon tujhe. ❤️"})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/memory', methods=['POST'])
def read_memory():
    try:
        data = request.get_json()
        if data.get('password') != MEMORY_PASSWORD:
            return jsonify({"error": "Wrong password"}), 403
        memory = load_memory()
        return jsonify({"memory": memory, "total": len(memory)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port)
