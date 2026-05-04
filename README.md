<center>

# Simple Summary

📝Yet another summarization extension for SillyTavern. [中文](https://github.com/bbw3000/SimpleSummary/blob/main/README_zh-CN.md)

![SimpleSummary - Home](https://files.seeusercontent.com/2026/05/02/g3zA/sp_home.webp)

</center>

## How to Use

This extension is easy to use with a simple and friendly interface. You can switch between multiple languages and light/dark themes using the button in the upper right corner.
The extension entry is located in the magic wand menu on the left side of the message input box. You can also open the extension using the `/sp` command.

* [ ] **Step 1. Configure API**
  - Supports Custom access points compatible with OpenAI format by default, suitable for many third-party APIs (e.g., OpenRouter, SiliconFlow). For advanced users, custom parameters can be used with the Custom access point.
  - Also supports three direct/proxy access points: OpenAI, Anthropic, and Google AI Studio.
  - Simply fill in the BaseURL and API Key, then pull the model list and select the model you want to use (or choose to enter it manually).
  - (Design detail: When using Anthropic or Google AI Studio points, the extension will first try to pull the model list using the OpenAI `/v1/models`. If there is no response, it will fallback to the built-in list in ST. This design facilitates some setups like NewAPI proxying.)
  
* [ ] **Step 2. Start Summarization**  
  - Return to the main page and select the range you want to summarize. After determining the summarization range (e.g., 0~30), you can directly click the "Generate" button, and the extension will start working. (streaming is enabled by default) You can see the summary being generated. When the output is complete, you can save it directly or review/modify it before saving. Before starting the summary, you can also click the "Request Preview" button to view the complete request information sent to the LLM (including LLM parameters, the summarization prompt, and the chat logs within the selected range).
  - **Note: The starting message number is not selectable.** This is by my design to prevent overlap with previously summarized message ranges. The starting message number is determined based on the last message marked as "hide". If this is your first time using this extension and the starting message number is not 0, you may have used other summarization extensions or manually hidden messages before. You can enable the "Auto-Repair Summary" function and refresh the page. The extension will automatically clear the hidden status of all un-summarized messages (for first-time use, this means unhiding all messages).
* [ ] **Step 3. That's it**
    - By default, the summary is automatically injected by the extension into the chat history at position `@depth 999` as a system message. You can see an entry like `Name: chatHistory-1, Role: system, Tokens: xxxx` in ST's preset ChatHistory. If you wish to control the injection position yourself, you can disable extension injection in the settings page and manually use the `{{SPSummaries}}` macro to inject it wherever you want. For example, you could place it in an ST preset, Lorebook, or the Author's Note.
  - The extension also supports Regex preprocessing. If you are playing with some front-end cards, you can use regex to filter out content from messages that you don't want to be summarized (e.g., character/NPC status, etc.).

## Why Choose this one?

After trying many other summarization extensions, I always felt I couldn't find one that suited me, so I decided to make my own.
Many extensions offer RAG, tables, or use specific formats.
But the actual results are often unsatisfactory. Why? Mainly two reasons:

- **LLMs lack temporal state.** Many people know that LLMs can even make mistakes on math problems like 9.8 - 9.11, so don't expect an LLM to accurately understand that something happening on September 11th comes after September 8th. Therefore, even if you timestamp every event, if the sequence is wrong, the LLM can still misunderstand. Using RAG technology to insert information entries can be even more disastrous, leading to chronological/event order chaos: you might not even immediately notice the consequences, because the LLM won't explicitly state its misunderstanding; it might be hidden within subtext or logic, and you might only realize much later, after several messages, that the LLM's understanding of the events has gone awry.
- **LLMs naturally tend towards sequential event ordering.** Although some older models might struggle with very long contexts, most current LLMs perform well in this regard. Sequential event context is the easiest way for LLMs to understand information first and foremost. LLMs are trained and learn to understand storylines using natural human language, which also means that the most common, straightforward summarization method is what LLMs can accept most accurately.

So, just like the extension's name suggests, it simply does one thing — compresses long context into natural language summaries.

## Other Information

- The extension registers several ST macros that you can use to design your own summarization prompts. They are:
  
  - `{{chatLang}}`: Determines the language distribution based on existing summaries / user messages within the currently selected range to be summarized. Outputs a list of plain text language percentages, one per line in descending order, e.g., `zh-CN: 78%, en: 20%`
  - `{{SPSummaries}}`: All existing summary content.
  - `{{latestSegment}}`: Only the `summaryText` of the most recent segment. Its length is significantly smaller than `{{SPSummaries}}`.
  - `{{chatLog}}`: The preprocessed chat messages within the selected range.