# Triage an issue

Triage lets your own coding agent investigate a T3 Code problem. The agent
reads the logs and state of the machine, checks the T3 Code source for that
version, finds known issues, and can help you write a good GitHub issue. It asks
before it applies a fix or posts anything.

## In the app

Open the command palette and choose **Triage an issue**. A new thread with no
project opens, with the triage playbook linked in the message. Choose any
provider, describe what went wrong after the link, and send. T3 Code gets the
source for the server's version while you write.

Triage runs on the machine of the thread or draft that you have open. With
nothing open, it uses your primary machine if that supports triage, or else the
first connected machine that does. The new thread shows the machine name, and on
mobile the palette row shows it before you start. The agent runs inside that T3
Code server, so it gives you any restart steps and does not do them itself.

## In a terminal

If the app does not start, or triage does not work in the app, run:

```sh
npx t3 triage
```

It starts Claude Code or Codex in your terminal with the same instructions.

T4 Code builds don't run triage, because it files issues on T3 Code's repository:
the app doesn't offer it and T4 Code's own `t3 triage` refuses. `npx t3 triage`
downloads T3 Code's CLI instead, so don't use it for T4 Code. Report T4 Code
problems in [its own issues](https://github.com/LukasDoubleU/t4code/issues).
