# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

On mobile, **New thread** starts in the current thread's project, or else in the
last project you opened or chose on that device. If neither is available, the
project picker opens. Turn off **Settings → General → Use last project** to
choose a project every time. When you pick a project that is on more than one
machine, the thread starts on a connected one if any is connected.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### The new thread dialog

On web and desktop, `mod+n` and the sidebar's new thread button open the new
thread dialog. It opens on the machine of your current thread, or the one you
picked last, with the current project highlighted, so Enter starts the thread
there. Pinned projects follow it, and archived projects are left out. Type to find
another project. To use another machine, press Backspace in
the empty search field or choose **Switch machine**. The same list adds projects:

- **Open folder** suggests the folders your projects are in and the Git
  repositories it finds there. Type a path to see matching folders; Tab completes
  one. Enter on a Git repository, or on a typed folder that exists, adds it and
  starts the thread. In the desktop app, **Browse…** opens the system folder picker
  for this computer.
- **Clone repository** takes `owner/repo` for GitHub, or an HTTPS or SSH clone URL.
  See [Start, clone, or publish a project](./source-control.md#start-clone-or-publish-a-project).

Typing a path or pasting a clone URL into the project search goes straight to the
matching step. Shift+click the new thread button, or press `mod+shift+n`, to skip
the dialog and start in the current project. With **Boring Sidebar** on, `mod+n`
and the button do that too.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from the new thread dialog, or press
`mod+alt+n`. On mobile, pick **No project** from the project
list. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Each thread without a project works in its own folder under `~/.t3/scratch` (the
`scratch` folder of your T3 data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

When the work grows into something real, pick **Turn into project** from the
thread's menu. The thread's folder becomes a project where it is, so nothing
moves and the agent keeps working in the same place. Other threads in that folder
move with it. Rename the project in its settings, and use **Initialize Git** to
get branch and diff controls.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

## The thread menu

Right-click a thread in the sidebar, or click its title in the header, to open its menu. On web
and desktop it keeps the everyday actions on top: pin, rename, change the icon, settle, snooze,
mark unread, and copy the thread's ID. The rest, such as **Regenerate title**, **Share with guest**,
**Open memory**, **Fresh start**, **Auto-settle behavior**, **Archive thread**, and **Delete**, is
under **More**.

### Give a thread its own icon

A thread shows its project's icon unless it has one of its own. To tell threads in one project
apart, for example your experts, choose **Change icon…** in the thread's menu and pick an icon,
emoji, or monogram; on mobile, type or paste an emoji. **Use project icon** takes it back. The icon
shows on every connected client, and agents can set it for the threads they manage.

## Catch up on a thread

When you open a thread with activity you have not seen, a **Since your last visit** line marks
the first item after your previous visit. It stays put while you read.

**Jump to my last message** scrolls back to the last message you wrote, loading older turns if
needed. On web and desktop, a **My last message** button floats above the composer, beside
**Scroll to end**, whenever that message is out of view; the command palette has it too, and
`mod+alt+up` runs it. On mobile, it is in the header's **Catch up** menu.

**Catch me up**, in the thread header, writes a short brief from the thread's items since your last message
or your last visit, whichever is earlier: what needs you, up to three things that happened, and
what comes next. An open question or approval, or an agent's call for you, always shows under
**Needs you**. The brief uses the text generation model from **Settings → General**. It is not a
message: the agent never sees it, and asking for one starts no turn and does not count as a
visit. The card keeps the brief until you dismiss it, and says so once new activity arrives;
**Refresh** writes a new one. On an older server, or with read-only access, **Catch me up** is
hidden.

## Experts: pin and reorder threads

Pin a thread from its menu to keep it above your active work. Pinned threads form the
**Experts** section, for the threads you keep for weeks. On web and desktop, click its header,
which shows how many there are, to collapse or expand it; each device remembers its choice.
Collapsed, the section keeps only the thread you have open, and a thread dropped onto the
header is pinned as the menu's **Pin** would. Experts lists the pinned threads of every
environment the app is connected to.

On web and desktop, experts that have been quiet for 8 hours fold into one row at the end of
the section, such as **12 quiet**; click it to list them, and again to fold them. An expert that
is working, needs you or has a result you have not opened always stays in view, and a folded one
comes back on its own as soon as it gets a message, starts a run or asks for you. Nothing is
unpinned or settled. Choose the window, or **Off** to list every expert, under **Settings →
General → Fold quiet experts**.

Each expert takes one line: its project, title, status or last activity, and a machine icon for a
thread on another machine. Hover the row to see its machine, branch, pull request, account, and
memory.

Experts often work without you: another agent messages them, a scheduled task runs, or the agent
wakes on its own, for example for a pull request it watches. A turn you did not start runs
quietly. Its **Working** is muted, and once it ends the row shows only its time, with no **Done**
and no notification. A turn you started still ends in **Done**, and so does a wake that finishes
it, such as background work it was waiting for. A result of yours you have not opened stays
**Done** behind later quiet turns.

When an expert's agent needs you, for a decision or something only you can do, it marks its
thread **Needs you** with a one-line reason. The row turns amber and comes forward like a
question, the reason shows on the row and in its hover card, and you are notified on desktop and
on your phone. In Experts the row shows only the amber hand; hover it for the reason. The agent
keeps working meanwhile. The mark clears when you write in the thread or react to a reply, or
when the agent clears it. To clear it without answering, click **Needs you** (or the hand) on the
row or choose **Dismiss Needs you** from the thread's menu. Any thread's agent can ask
this way, not only an expert's.

A thread an expert's agent starts for one subject is one of its topics, and so is a thread one of
its subagents or topics starts. On web and desktop, the expert's row counts its open topics; click
the count to show them nested under it, instead of in Background. A topic that needs you comes
forward as usual, settled topics leave, and a topic's chat opens with a link back to its expert.

To start a topic yourself, without interrupting the expert, choose **Start new topic** in the
expert's menu, or **New topic of** in the command palette. It opens a new thread in the expert's
project that starts with a link to the expert, so its agent can read up on the expert's work. Pick
the model and workspace as for any new thread; once you send, it nests under the expert and
notifies you like any thread you started.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments. `mod+z` triggers the most recent Undo, even from the composer; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Automatic settlement skips pinned threads. Settling a thread yourself removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
Experts to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of Experts does not ask for unpin confirmation.
The Active boundary label, and the Experts label while nothing is pinned, appear only while
dragging, without moving the rows. The other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, **Wake**, **Background**, or **Bring to front**. Its status and hover
actions hide during the drag. A pinned
thread keeps its pin only while it stays in Experts; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; close the sheet to return to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

To order pinned and active threads by recent messages or by status instead, see
[Sort and group threads](#sort-and-group-threads).

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

To change how titles are written, add **Thread title instructions** in **Settings → Threads →
Text generation**, under Advanced, such as a length limit or an identifier to put first. They apply to new and
regenerated titles. Select a project to give it its own instructions.

Agents connected through T3 Code can use the same server-owned metadata workflow to
rename a thread, regenerate its title, set or clear its icon, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Follow every expert in one feed

On web and desktop, the speech-bubble button on the Experts header, or **Open experts feed** in the
command palette, opens the **Experts** feed: the latest replies of every expert, on every connected
machine, in one list with the newest at the bottom. Each entry names its expert, its machine when
it is another one, and the expert's status. Messages from other agents and automations fold into
one line that names the sender; long replies show their start until **Show more**.

**Reply** on an entry sends your message into that expert's own thread, as if you typed it
there: it starts a turn, or steers or queues behind a running one as your follow-up setting says.
The experts do not see each other's replies. Click an expert's name to open its thread.

### Keep a memory for a pinned thread

A thread you keep for weeks loses detail every time its conversation is compacted. A pinned
thread keeps a memory file against that: its agent is told where the file is, reads it at the
start of a session and after every compaction, and keeps it current with the thread's purpose,
the current state, decisions and their reasons, your preferences, and open points. The history
stays in the thread, and secrets stay out of the file.

While the memory is active, hovering the expert's row shows when the file last changed, or
**No notes yet** before the agent has written it. Choose **Open memory** in the
thread's menu to open the file in your editor; for a thread on another machine, its path is
copied instead. You can edit the file yourself.

Unpinning lets the memory sleep: the file stays, and pinning the thread again picks it up. Forks,
subagents, and delegated tasks start without one. The files live in the environment's state
folder, usually `~/.t3/userdata/memory`. To turn memories off for an environment, go to
**Settings → General → Pinned threads keep a memory**. A change takes effect on the thread's next
turn. Claude, Codex, and OpenCode threads use the memory; other providers work as before.

When a pinned thread's conversation has grown too long, choose **Fresh start** in its menu. A new
thread with the same title, model, and settings takes its place among the pinned threads, along
with its memory file, and its agent reads the memory first and carries on in the same role. The old
thread is settled and keeps its history; each one's menu links to the other. Agents that look the
thread up by name find the new one, and a message an agent sends to the old one is refused with
the new thread's ID. A thread that is still working or waiting on you can't start fresh yet.

When the context of a pinned thread comes close to full, its next turn reminds the agent to update
the memory before the conversation is compacted, once each time it gets there. This works where
the provider reports the size of its context window, as Claude, Codex, and OpenCode do.

At the end of each turn, a memory file that changed is copied to a `backups` folder next to it,
keeping the last 20 versions of each thread's memory. To undo a bad edit, copy an earlier version
back over the memory file. When a pinned thread has run 20 turns without changing its memory, the
expert's hover says so.

### Sort and group threads

On web and desktop, the sort button at the top of the sidebar sets how threads are sorted and
grouped. Each device keeps its own choice.

**Sort** orders pinned and active threads, each section on its own. **Manual** keeps the
arrangement you dragged into place. **Last
message** puts recent conversations first, matching the age shown on the row; threads without
messages use their update time. **Status** puts threads in this order, newest message first within
each:

1. **Needs you**: a question or approval is waiting, its agent asked for you, or a snooze just
   ended.
2. **Failed**: the latest run failed, including runs stopped by a usage limit.
3. **Completed**: finished work you started and have not opened yet. Opening the thread makes it
   idle.
4. **Working**: the agent is running or waiting on background work.
5. **Idle**: everything else.

With **Last message** or **Status** you cannot rearrange pinned or active threads, but you can
still drag them between sections; the sort decides where a dropped thread lands. **Manual** brings your saved arrangement back. While the Working section is
on, it orders an ungrouped list by itself.

**Group** puts active threads in folders: one per **Project** (see below), one per **Machine**
starting with your current machine, or one per **Status** in the order above. A machine or status
folder appears only while it holds threads, and threads move between folders as their status
changes. Threads inside a folder follow the sort. Click a folder to open or close it. Pinned threads
stay above the folders, and snoozed and settled threads keep their sections below them. Grouped
threads cannot be dragged, and the Working section is off. **None** returns to one list.

### Keep agents' threads in the background

On web and desktop, threads that an agent starts on its own, here or from a linked machine, wait
in a collapsed **Background** section near the bottom of the sidebar until you write in them.
Threads you start yourself stay in the main list, even when you
[start them in the background](#start-in-the-background). Expanded, the section lists its
threads in the current sort, as one list whatever the grouping. A thread there
comes back to the main list while it needs you: a question or approval is waiting, its agent
asked for you, a snooze ended, or its run failed, the first two groups of the **Status** sort. Once you have dealt with
it, it returns to Background. Settling still moves a finished thread to **Settled**, and
subagents stay with their parent thread.

To move any thread yourself, choose **Move to background** or **Bring to front** from its menu,
or drag it between the active list and the **Background** header. A thread that needs you moves
to Background only once you have dealt with it. A thread you moved to Background comes back when
you write in it again; one you brought to front stays in the main list. Pinned, snoozed, and
settled threads keep their own sections. Each device keeps its own choices. To show every thread
as before, turn off **Background section** in the sort menu.

### Fold working threads (beta)

Threads that are working or waiting on work they will resume from move into a collapsed
**Working** section below the active list.
That includes subagents, watched pull requests, and background commands or monitors the agent
says it is waiting on. A dev server or other process an agent leaves running does not keep a thread
there. A thread returns to the top of the active list when it finishes, fails, or needs an approval or
answer. The Working section lists the thread you last sent work to first. Pinned threads stay in
Experts.

This is on by default. Turn it off with **Settings → General → Working section** on web and desktop,
or **Settings → General → Working section** on iOS and Android. Each device keeps its own
choice.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag or move threads within it. Your saved order returns when you turn it off.

### Group threads by project (beta)

Choose **Group > Project** in the sort menu, or turn on **Settings → Labs → Boring sidebar (group
by project)** on web and desktop, to put active threads in a folder for each project. A project with
no active threads has no folder unless it is pinned or you pick it in the project filter. Click a
folder to open or close it. A closed folder shows how many threads it holds, and a dot when one of
them needs you. Use the pen button on a folder, or right-click it, to start a thread in that
project. Pinned threads stay above the folders, and Background, Snoozed and Settled stay below them.
In this mode you cannot drag threads, and the Working section is off. Threads in each folder follow
the sort. Pinned projects come first, then the others in **Settings → General → Project order**; an
archived project's folder comes last and shows only while it has active threads. Each device keeps
its own choice.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open.

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`t3.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. An empty thread's inactivity counts from when it was created.
Work in progress, pending questions or approvals, and background work the agent
is waiting on prevent automatic settlement. An open pull request does not prevent inactivity
settlement unless you turn on **Keep threads with a PR** in **Settings → Threads**,
but an old closed or merged pull request does not settle work you
resumed after it closed. Only your own messages count as resuming. A turn that
finished background work or a pull request watch starts on its own does not.

To keep one thread out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Disabled**. The current option is checked. Pick
**Enabled** to return to the usual rules. Manual settle, snooze, and archive still work while it
is disabled.

Change these rules in **Settings → Threads**.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments by title, branch, pull request, or project.
Threads you open often or recently rank higher, and for three weeks the thread
you last picked for a query ranks higher when you type that query again.
Threads whose messages contain all your words appear below, under **In
messages**, and open at the matching message. Message search needs at least
one word of three or more letters, or two for Chinese, Japanese, and Korean.
On mobile, the thread list search also lists message matches and opens them at
the matching message; on an iPad with a keyboard, `Cmd+K` opens the same
palette.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise the thread itself, which pastes into a composer as
a thread chip. To copy the thread even when it has a PR, choose **More → Copy → Thread**
from its context menu, or **Copy thread** from its long-press menu on mobile.
**Copy thread ID** copies the bare ID for scripts and the `t3` CLI. See
[keybindings](./keybindings.md) for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance. With several Claude or Codex accounts, T3 moves the
turn to the next account by itself; see [Usage and limits](./usage.md#track-subscription-limits).
On web and desktop, press **Resume** in an empty composer to continue a limited
or interrupted turn manually.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the thread. Enable **Resume after
usage limits** in **Settings → Threads** to schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Stopping the thread, sending a new message,
archiving, or settling it prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze until limits reset** in thread behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents.
On mobile, open a subagent from its conversation card or **Agents**. On iOS
layouts with an inspector, its thread opens beside the parent. Maximize it to
fill the screen; close the full-screen view to return to the parent and inspector.
Stop on a thread also stops the subagents it delegated to.

Subagent threads started by the agent can't take messages; message the parent
thread instead. When such a subagent needs an approval or an answer, the parent
thread asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

On web and desktop, the thread details card lists the local servers that the
thread's terminals or its Claude agent started, with their ports. Not every one
serves a web page. A server the agent started stays listed after the agent's
turn ends.
Select a server to open it in the browser panel. **Stop** ends the server's job
and keeps the agent, the terminal, and T3 Code running. Stop needs terminal
access to the environment and is not available on Windows.

To choose what the thread details card shows, right-click the card or open
**Settings → Appearance → Thread details**. Hidden rows keep their keyboard
shortcuts, such as Open in editor and project scripts. **Reset to default** brings
back the standard rows.

## Side chats

A side chat lets you ask a question about a thread without adding to it. It starts
with what the thread knows, and the thread keeps working while you ask.

On web and desktop, start a message with `/side` or `/btw`, then your question.
You can also choose **Side chat** from the **+** menu in the right panel. The side
chat opens as a tab there, with its own composer. Side chats do not show in the
sidebar. Find one again under **Side chats** in thread details.

A side chat works in the same folder as the thread. Its first reply asks before it
edits files or runs commands. After that, it uses the permission mode you choose
in its composer.

To use what you learned, choose **Bring back**. The thread gets the side chat with
your next message there. Bring back is available while the thread is idle.

Closing a side chat you never sent a message in deletes it. To delete one you used,
choose **Delete** at the top of the side chat. Deleting a thread also deletes its
side chats.

On mobile, a thread lists its side chats above the composer. Tap one to open it and
answer its questions.

## Snooze until later

To change the choices in the snooze menu, open **Settings → Threads → Snooze options**.
Each option is a duration, such as 3 hours, or a time on a day, such as 9:00 PM
tomorrow. A weekday means the next one after today. Menus list the options soonest
first and hide a today option after its time passes. Saved with **All environments**
selected, the options apply to every connected environment, and the mobile app uses them too.

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.
A snoozed thread keeps working and stays hidden until its wake time, even while
its agent wakes itself for background work. It comes back early only when it needs
an approval or answer from you, when a run fails, or when you send it a message.
