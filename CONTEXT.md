# MiniSago

MiniSago receives Discord requests, assigns them to authenticated workers, and returns bounded results under hosted authority.

## Language

**Workflow**:
A reservation that keeps related jobs on one worker while a Discord request is routed and answered.
_Avoid_: Session, task

**Answer job**:
A worker request to produce MiniSago's response through the selected chat, Mac, or Oracle route.
_Avoid_: Chatbot job, request job

**Execution route job**:
A worker request that classifies an owner's request before an answer job is created.
_Avoid_: Router job, planning job

**Trace lookup job**:
A worker request for bounded observable metadata about an earlier answer.
_Avoid_: History job, reasoning lookup

**Social action job**:
A worker request that decides whether MiniSago should quietly react to a buffered Discord conversation.
_Avoid_: Ambient job, reaction job
