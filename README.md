# 🛸 Antigravity Web UI (English Standalone Edition)

A modern, responsive, and secure Web Interface and Remote Control Dashboard for **Google Antigravity CLI (`agy`)**.

Designed with a ChatGPT / Claude styled dark aesthetic, real-time WebSocket communication, embedded web terminal, built-in code editor & file explorer, and enterprise-grade security controls.

---

## ✨ Features

- **💬 Real-Time Streaming Chat (`/ws/chat`)**
  - Instant token streaming with markdown rendering, LaTeX equations, and syntax highlighting.
  - Multi-turn conversation management with autosave, rename, and session history.
  - File drag-and-drop attachments with automatic summarization.
  - Slash command autocomplete (`/plan`, `/goal`, `/schedule`, `/learn`, `/boost`, `/browser`, `/grill-me`, `/teamwork-preview`).

- **🖥️ Embedded Web Terminal (Xterm.js + ConPTY)**
  - Full-featured browser terminal running PowerShell or direct `agy` CLI sessions.
  - Native UTF-8 encoding support with Windows ConPTY backend.
  - Terminal command input bar with history navigation (Up/Down arrow keys) and Hangul/IME composition buffer.

- **📁 Project File Explorer & Code Editor**
  - Interactive project directory tree viewer with breadcrumb navigation.
  - In-browser code viewer and editor with syntax highlighting.
  - Direct file editing and saving with instant toast notifications.
  - One-click file download button.

- **🛡️ Enterprise Security & Access Control**
  - **Salted Bcrypt Password Protection**: Secure password hashing with interactive password change dialog.
  - **Active Session Management**: View all logged-in IP addresses, devices, creation times, and revoke sessions on demand.
  - **Safety & Execution Approvals**: Toggle tool auto-execution vs. pre-approval mode with interactive diff review.
  - **Secure HTTP Headers**: X-Frame-Options (Clickjacking guard), MIME sniffing protection, XSS headers, strict referrer policy.

- **📊 Quota & Token Monitor**
  - Real-time token usage meter and quota synchronization.
  - Gemini & Claude/GPT rate limit visualizers (5-hour and weekly refresh countdowns).

---

## 🚀 Quick Start

### 1. Prerequisites

- **Python 3.10+** (Windows, macOS, or Linux)
- **Antigravity CLI** (`agy` installed and authenticated)

### 2. Installation

Clone this repository and navigate into the project directory:

```bash
git clone <YOUR_REPO_URL>
cd antigravity-web-en
```

Create and activate a virtual environment (recommended):

```bash
# Windows
python -m venv .venv
.venv\Scripts\activate

# macOS / Linux
python3 -m venv .venv
source .venv/bin/activate
```

Install the dependencies:

```bash
pip install -r requirements.txt
```

### 3. Configuration

Copy the example environment configuration:

```bash
cp .env.example .env
```

Edit `.env` to set your custom web password and port settings:

```env
# Set your initial dashboard access password
ACCESS_PASSWORD=my_strong_password

# Enable web terminal (recommended: true for local access)
ENABLE_WEB_TERMINAL=true

# Server Host and Port
HOST=0.0.0.0
PORT=8000
```

### 4. Running the Server

Start the web server:

```bash
python run.py
```

Or double-click `start.bat` on Windows.

Open your browser and navigate to:
```
http://localhost:8000
```

Enter your configured `ACCESS_PASSWORD` to access the dashboard.

---

## 🛠️ Project Structure

```
antigravity-web-en/
├── app/
│   ├── main.py              # FastAPI server, WebSocket endpoints & security middleware
│   ├── config.py            # Environment configuration & binary detection
│   ├── auth.py              # Token generation, session revocation & bcrypt verification
│   ├── agent.py             # agy CLI bridge & subagent event stream dispatcher
│   ├── models.py            # Pydantic schemas & state models
│   ├── tools.py             # Tool execution & approval handler
│   ├── security.py          # Path traversal validation & sandbox guards
│   ├── conversations.py     # Conversation persistence & storage
│   └── quotas.py            # API token usage & rate limit parsers
├── static/
│   ├── index.html           # Single-page web dashboard application
│   ├── app.js               # Client-side WebSocket manager, terminal & UI logic
│   └── style.css            # Dark mode UI styling & animations
├── requirements.txt         # Python package dependencies
├── .env.example             # Example environment configuration
├── .gitignore               # Ignored files and sensitive credentials
├── run.py                   # Server launcher
└── README.md                # Documentation
```

---

## 🔒 Security Best Practices

1. **Never commit `.env`**: Always keep your passwords and API tokens safe. The `.gitignore` is preconfigured to prevent accidental commits.
2. **Web Terminal Access**: The embedded web terminal is restricted to localhost (`127.0.0.1`) by default. Do not expose the terminal port to public networks without proper tunneling and token authentication.
3. **Change Default Password**: Change the initial password immediately upon first login using the **Change Access Password** modal.

---

## 📄 License

This project is licensed under the MIT License.
