# Optane AI: Core Audit & Enforcement Engine

## Overview
This repository contains a curated technical showcase of the Optane AI Audit Engine. While the full startup infrastructure (comprising 5,000+ lines of frontend, backend, and proprietary billing logic) remains private, this engine represents the "brain" of the system's integrity.

It was engineered to bridge the gap between autonomous AI voice-workflows and structured financial enforcement, ensuring the platform remains technically robust and fiscally accurate.

## Key Architectural Enforcements

### 1. Idempotency & Transactional Safety
To mitigate the risks of duplicate billing during network retries or external API failures (e.g., Paddle/Vapi), the system utilizes Unique Event Identifiers. 
* The Logic: The audit script (specifically Pipeline Tests 5 & 7) verifies that the system enforces "Exactly-Once" processing, preventing redundant state changes.

### 2. Temporal State Management (The Killswitch)
This engine manages a complex state machine for B2B client accounts, handling:
* Atomic Payment Handling: Synchronizing subscription status with API access.
* Usage-Based Grace Periods: Calculating time-gated access (`usage_invoice_due_at`) before triggering a system-wide "Killswitch" for unpaid usage.

### 3. Diagnostic Integrity
The codebase demonstrates a proactive diagnostic layer. Instead of failing silently, the logic detects "Skips" (e.g., missing `paddle_address_id` or `price_usage_id`), allowing for immediate recovery of system-wide reconciliation.

## Technical Stack
* Language: TypeScript / Node.js
* Database: Supabase (PostgreSQL) with custom RPC triggers
* Integration: Paddle Billing & Vapi (Voice-AI) Infrastructure

## Purpose of this Showcase
As highlighted in my Statement of Purpose for UTS Sydney, my transition from "implementation-driven" learning to "principled AI development" requires a deep respect for logic and architectural rigor. This repository serves as evidence of that transition—demonstrating my ability to design scalable, responsible, and logically sound AI infrastructure.
