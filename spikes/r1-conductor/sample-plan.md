# Greeting Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add two greeting files and a combined file.

**Architecture:** Plain text files in the repo root. No code.

---

### Task 1: hello file
Depends on: none
Agent: implementer
Owns: hello.txt
Acceptance: hello.txt exists and contains exactly `hello`

- [ ] **Step 1:** Create `hello.txt` containing `hello`.
- [ ] **Step 2:** Commit: `git add hello.txt && git commit -m "add hello"`

### Task 2: world file
Depends on: none
Agent: implementer
Owns: world.txt
Acceptance: world.txt exists and contains exactly `world`

- [ ] **Step 1:** Create `world.txt` containing `world`.
- [ ] **Step 2:** Commit: `git add world.txt && git commit -m "add world"`

### Task 3: combined file
Depends on: T1, T2
Agent: implementer
Owns: greeting.txt
Acceptance: greeting.txt contains `hello world` (built from hello.txt and world.txt)

- [ ] **Step 1:** Create `greeting.txt` containing the content of `hello.txt`, a space, then the content of `world.txt`.
- [ ] **Step 2:** Commit: `git add greeting.txt && git commit -m "add greeting"`
