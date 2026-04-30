from flask import Flask, render_template, request, jsonify
import requests

app = Flask(__name__)

# CONFIGURATION
API_KEY = "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"
API_URL = "https://openrouter.ai/api/v1/chat/completions"

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/api/chat', methods=['POST'])
def chat():
    try:
        data = request.get_json()
        user_text = data.get('message')

        headers = {
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:5000",
            "X-Title": "Ipsita-Sathi"
        }

        # Backup models list taaki crash na ho
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
                continue # Agar ek model fail ho toh doosre par jao
            
        return jsonify({"response": "Ipsita, Sathi thoda rest kar rahi hai. Ek baar phir try karein?"})

    except Exception as e:
        print(f"Error: {str(e)}")
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5000)