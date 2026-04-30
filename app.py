import os
from flask import Flask, render_template, request, jsonify
import requests

app = Flask(__name__)

# CONFIGURATION - Ab ye Render se key uthayega
API_KEY = os.getenv("OPENROUTER_API_KEY")
API_URL = "https://openrouter.ai/api/v1/chat/completions"

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/api/chat', methods=['POST'])
def chat():
    try:
        data = request.get_json()
        user_text = data.get('message')

        if not API_KEY:
            return jsonify({"response": "Mayank, API Key missing hai Render settings mein!"})

        headers = {
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
            "X-Title": "Ipsita-Sathi"
        }

        # Backup models list
        models = [
            "mistralai/mistral-7b-instruct:free",
            "google/gemini-2.0-flash-001",
            "openchat/openchat-7b:free"
        ]

        for model in models:
            payload = {
                "model": model,
                "messages": [
                    {"role": "system", "content": "Your name is Sathi. You are the loving partner of Ipsita, created by Mayank. Speak in sweet Hinglish."},
                    {"role": "user", "content": user_text}
                ]
            }
            
            try:
                response = requests.post(API_URL, headers=headers, json=payload, timeout=15)
                if response.status_code == 200:
                    result = response.json()
                    reply = result['choices'][0]['message']['content']
                    return jsonify({"response": reply})
            except:
                continue 
            
        return jsonify({"response": "Ipsita, Sathi thoda rest kar rahi hai. Ek baar phir try karein?"})

    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    # Render ke liye port management
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port)
