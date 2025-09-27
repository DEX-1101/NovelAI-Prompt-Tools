# 🎨 NovelAI Prompt Tools

A simple yet powerful Tampermonkey userscript designed to supercharge your prompting workflow on NovelAI. This script adds essential features like hotkey-based weight adjustments and intelligent tag autocompletion.

---

## ✨ Features

-   **🚀 Hotkey Weight Adjustments:** Quickly increase or decrease the emphasis of your tags. Select a word and press a hotkey to wrap it in `1.3::1girl::`, saving you time and effort.

    ![Adjusting prompt weights with hotkeys](https://raw.githubusercontent.com/DEX-1101/NovelAI-Prompt-Tools/refs/heads/main/sample/weight.gif)

-   **🧠 Smart Tag Autocomplete:** Get instant suggestions for danbooru tags as you type (with Latest Artist and Character Tags, both NSFW and SFW).

-   **⚙️ Fully Customizable:** Easily change the hotkeys and weight adjustment values through a clean and simple settings menu to perfectly match your workflow.

    ![Customizing hotkeys and settings](https://raw.githubusercontent.com/DEX-1101/NovelAI-Prompt-Tools/refs/heads/main/sample/ui.gif)

---

## 🛠️ Installation Guide

Getting started is easy! Just follow these three steps.

1.  **Install a Userscript Manager**
    -   You need an extension to run this script. We recommend [**Tampermonkey**](https://www.tampermonkey.net/).
2. **Enable Developer Mode & Allow Script**
   -    Open extension settings by right-clicking the Tampermonkey icon (1) and selecting "Manage Extension" (2).
         ![manage extension](https://www.tampermonkey.net/images/manage_extension.jpg)
   -    Locate and enable the "Allow User Scripts" toggle
         ![allow_script](https://www.tampermonkey.net/images/userscripts_toggle.png)
   -    Enable Developer Mode by clicking the toggle at the top right.
         ![enabled dev mode](https://www.tampermonkey.net/images/developer_mode.jpg)


4.  **Install the Script**
    -   Click the button below to install the NovelAI Prompt Tools script directly.

        [![Install Userscript](https://img.shields.io/badge/Install%20Userscript-0078D7?style=for-the-badge&logo=javascript&logoColor=white)](https://github.com/DEX-1101/NovelAI-Prompt-Tools/raw/refs/heads/main/NovelAI_Prompt_Tools.user.js)

3.  **All Set!**
    -   Open or refresh the [NovelAI Image Generation](https://novelai.net/image) page. The script will be active automatically!

---

## 📌 Important Notes

-   **Permissions:** The first time you use the script, it may request permission to fetch data from an external source. This is **required** for the tag autocomplete feature to work. Please approve the request.
-   **Browser Compatibility:** This script has been tested and works perfectly with **Chrome**, **Firefox**, and **Brave**.
-   **How to Update:** To ensure you have the latest version, go to your **Tampermonkey Dashboard**, click on the script name, and use the built-in update checker `(File > Check Update).`
