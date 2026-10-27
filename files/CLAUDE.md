# Token & Output Efficiency
- Reply in the most concise form possible. Skip pleasantries, preambles, and recaps.
- Do not narrate tool calls before or after running them; run the tool and report only the findings.
- Batch related shell/file operations into single turns whenever possible.

# Continuous Auto-Memory Sync
- As you complete major steps, bench runs, or discover findings, silently update the active investigation `.md` file in your project `memory/` directory so the user never has to remind you to save state.
