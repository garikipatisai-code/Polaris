# **Architectural Framework for Constrained-Context, Long-Horizon Browser Agents**

Building highly autonomous web agents on resource-constrained consumer hardware requires resolving a fundamental engineering conflict: web pages are increasingly bloated, dynamic, and adversarial, while local models are bounded by tight compute and memory budgets. Running a local four-billion-parameter model, such as Qwen3.5-4B (an architecture utilizing Grouped Query Attention and hybrid State Space Model/attention layers), on a 5GB GPU and 32GB RAM box limits practical execution to approximately 20 tokens per second with a functional context ceiling of \~16,000 tokens per turn. Under these execution constraints, standard iterative architectures such as ReAct suffer from cognitive drift and context exhaustion as non-standard DOM layouts and session histories accumulate.  
To ensure the agent remains locked on the user's original goal during long-horizon shopping operations, the engineering focus must shift from naive context scaling to precise state preservation, symbolic prompt compression, and asynchronous background execution.

## **External Memory Architectures**

In long-horizon tasks, maintaining task-state consistency across hundreds of page navigations requires strict decoupling of working memory from episodic interaction history. Standard retrieval-augmented generation (RAG) over raw browser interactions degrades quickly on small models due to noise in HTML structures and conversational text. Advanced external memory architectures address this by organizing information into distinct, addressable functional regions managed by programmatic rules rather than relying entirely on model attention.

### **Architectural Memory Parallels**

\+-----------------------------------------------------------------+  
|                      Local Client Memory                        |  
|   \+-------------------+                \+--------------------+   |  
|   |  chrome.storage   | \<============\> |     IndexedDB      |   |  
|   |  (Global State)   |                |  (Episodic State)  |   |  
|   \+-------------------+                \+--------------------+   |  
\+-----------------------------------------------------------------+  
                                 ^  
                                 | (Paging / Tool Read-Write)  
                                 v  
\+-----------------------------------------------------------------+  
|                     Local LLM Context Regs                      |  
|   \+-------------------+                \+--------------------+   |  
|   |   Primary Reg     | \<============\> |   Archival Reg     |   |  
|   |  (Active Prompt)  |                | (Summarized Facts) |   |  
|   \+-------------------+                \+--------------------+   |  
\+-----------------------------------------------------------------+

| Named Technique | Source Citation | Applicability to Target Edge Stack | Implementation Complexity | Measured Gain | Composition or Conflict with Baseline |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Virtual Memory Architectures (MemGPT)**: Implements a virtual memory paging subsystem that moves data between active context registers and external storage using explicit read/write tool calls.1 | Packer et al., "MemGPT: Towards LLMs as Operating Systems" (arXiv:2310.08560 / https://github.com/cpacker/MemGPT) \[unverified\] | **High**: Necessary for Qwen3.5-4B's 16K limit; offloads past retail page details to external storage. | 5 to 7 days of work | Enables continuous operation over hundreds of turns; mitigates context fragmentation.1 | Composes with persistent storage setups. |
| **Shared Memory Blocks**: Uses background agents to modify shared memory blocks asynchronously, keeping the primary model focused on execution.2 | Letta Platform Docs (https://github.com/letta-ai/letta) 2 | **Medium**: Local 5GB GPU limits concurrent model executions; background updates must run sequentially during idle periods.3 | 1 to 2 weeks of work | Lowers the required active-turn context by summarizing past details.2 | Composes well but requires careful scheduling of local model processes. |
| **Hybrid Symbolic+Vector Memory**: Represents visited shopping sites as a structured entity-relation graph, where products, merchant policies, and prices are nodes connected by verified links.1 | Packer et al. 1 | **High**: Excellent for shopping; small models parse structured JSON nodes much more reliably than unstructured text. | 4 to 6 days of work | Eliminates retrieval hallucinations on previously visited pricing structures \[unverified\]. | Composes with JSON-based DOM adapters. |

## **Skill Libraries and Continual Learning Across Sessions**

When agents browse highly dynamic retailer sites, discovering functional navigation paths (such as locating checkout paths or product filter options) can be computationally expensive and error-prone. Rather than exploring pages from scratch on every run, the agent can use a persistent library of modular, verified browser actions (skills). This shifts the system's operational paradigm from exploratory prompting to executing deterministic, parameterized code scripts.

| Named Technique | Source Citation | Applicability to Target Edge Stack | Implementation Complexity | Measured Gain | Composition or Conflict with Baseline |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Embodied Skill Libraries (Voyager)**: An open-ended learning paradigm that writes, refines, and stores execution skills as executable JavaScript functions within a permanent library.1 | Wang et al., "Voyager: An Open-Ended Embodied Agent with Open-Ended Skills" (arXiv:2305.16291 / https://github.com/minecreator/voyager) \[unverified\] | **High**: Shifting repetitive navigation steps from dynamic prompting to compiled code saves precious edge computing cycles. | 1 to 2 weeks of work | Achieves high task success rates by executing reusable, error-corrected browser functions \[unverified\]. | Composes with Executor tool definitions. |
| **Guided Replay with Web Tutorials (AgentTrek)**: Harvests text-based web tutorials and transforms them into task goals with step-by-step instructions for guided execution.5 | Xu et al., "AgentTrek: Agent Trajectory Synthesis via Guiding Replay with Web Tutorials" (arXiv:2412.09605 / https://github.com/xlangai/AgentTrek) 7 | **Medium**: Excellent for compiling offline workflows; too heavy to run dynamically during active shopping sessions.6 | 2 to 3 weeks of work | Yields a 230% performance increase on long-horizon tasks when following detailed tutorial instructions.6 | Composes with DOM adapters by translating steps into reliable JSON actions. |
| **Unsupervised Trajectory Mining (VideoAgentTrek)**: Automatically extracts computer-use trajectories and precise action parameters from raw, unlabeled screen recordings using learned inverse dynamics.9 | Xu et al., "VideoAgentTrek: Unsupervised Computer-Use Agent Training from Web Videos" (arXiv:2510.19488) 9 | **Low**: High computational demands for video parsing and action localization restrict this to offline development.9 | Weeks of complex ML engineering | Improves task success rates on OSWorld-Verified by 70% relative to standard baselines.9 | Composes with the baseline as an offline training pipeline for the local Qwen model. |
| **Expectation-Maximization Reinforced Self-Training (ReST-EM)**: An iterative self-training framework that collects model-generated trajectories, filters them using binary rewards, and fine-tunes the base model on correct traces.10 | Rastogi et al., "Beyond Human Data: Scaling Self-Training for Problem Solving with ReST-EM" (arXiv:2312.11898 / https://github.com/google-research/rest) \[unverified\] | **High**: Can be run offline on the user's host machine to optimize the local 4B model using accumulated successful shopping paths.10 | 3 to 5 days of work | Outperforms supervised fine-tuning on human-written solutions; improves performance across medium/hard tasks.10 | Composes with the baseline by improving the fundamental execution capabilities of the local model. |

## **Context and Prompt Compression**

Raw DOM hierarchies and session histories quickly saturate a 16K practical context window, leading to high processing latency on a 5GB GPU box. Token-deletion models (such as LLMLingua-2) utilize a small, fast transformer classifier to prune low-perplexity tokens from the input context.1 However, because token-deletion methods output fragmented, ungrammatical text, smaller models like Qwen3.5-4B often suffer from a decline in reasoning capability.14  
To maintain instruction-following accuracy, the agent should instead perform a full semantic rewrite of the input text into a highly compressed, symbol-rich, formally structured dialect.1

| Named Technique | Source Citation | Applicability to Target Edge Stack | Implementation Complexity | Measured Gain | Composition or Conflict with Baseline |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **LLMLingua-2 Token Deletion**: Uses a compact bidirectional transformer encoder to classify and prune low-perplexity tokens from the context window.1 | Pan et al., "LLMLingua-2: Data Distillation for Task-Agnostic Prompt Compression" (arXiv:2403.12968 / https://github.com/microsoft/LLMLingua) 1 | **Medium**: Pruned, ungrammatical text can degrade the parsing performance of a local 4B model.14 | 2 to 3 days of work | Achieves up to 20x compression with minimal performance drop on frontier models.15 | Composes with DOM adapters as an intermediate pre-processing layer.16 |
| **Telegraph English Symbolic Rewriting**: Translates natural language inputs into structured atomic facts using a formal symbolic grammar and logical mapping rules.1 | Arbuzov et al., "Telegraph English: Semantic Prompt Compression via Structured Symbolic Rewriting" (arXiv:2605.04426 / https://github.com/telegraph-english/te) 14 | **High**: Structured symbols provide explicit relational signals, which compensate for the limited processing depth of small models.14 | 3 to 5 days of work | Preserves 99.1% factual accuracy at 50% token reduction; outperforms LLMLingua-2 by 11% on small models.14 | Composes perfectly with DOM adapters to format JSON extraction payloads.1 |
| **Chain-of-Density (CoD) Summarization**: Iteratively compresses context by replacing redundant words with dense, entities-rich summaries \[unverified\]. | Adams et al., "From Sparse to Dense: GPT-4 Summarization with Chain-of-Density Prompting" (arXiv:2309.04269) \[unverified\] | **Low**: Iterative summarization requires multiple prompt passes, which introduces high latency at 20 tok/s. | 2 to 3 days of work | Produces dense, human-preferred summaries on GPT-4 \[unverified\]. | Composes with the Planner but slows down execution speed. |
| **AutoCompressors (Soft Prompts)**: Trains summary tokens that substitute for long contexts.1 | Chevalier et al., "Adapting Language Models to Compress Contexts" (arXiv:2305.14788) \[unverified\] | **Low**: Modifying the raw model parameters of a local Ollama instance is highly impractical. | Weeks of ML engineering | Successfully condenses context windows into dense virtual prompt tokens.1 | Conflicts with out-of-the-box local model backends. |

## **Verification and Grounding Patterns**

Local vision-language models typically exhibit lower spatial reasoning accuracy when predicting exact numerical coordinates on high-resolution displays.18 To ensure reliable element selection on retailer sites, the system must translate coordinate-based actions into structured choice selections.  
By partitioning the web page into segmented regions and overlaying alphanumeric markers directly onto the screenshot, Set-of-Mark (SoM) visual prompting simplifies complex spatial tasks into straightforward multiple-choice selections.18

| Named Technique | Source Citation | Applicability to Target Edge Stack | Implementation Complexity | Measured Gain | Composition or Conflict with Baseline |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Set-of-Mark (SoM) Prompting**: Partitions screenshots into interactive regions using segmentation models and overlays numeric or alphabetic marks to aid spatial reference.18 | Yang et al., "Set-of-Mark Prompting Unleashes Extraordinary Visual Grounding in GPT-4V" (arXiv:2310.11441 / https://github.com/microsoft/SoM) 19 | **Medium**: Off-the-shelf segmentation models are heavy for edge devices; requires a lightweight local execution pipeline.19 | 4 to 7 days of work | Outperforms state-of-the-art fully-finetuned models on referring expression comprehension tasks.19 | Composes with the multimodal vision fallback tool. |
| **Graph-of-Mark (GoM) Scene Prompting**: Overlays scene graphs directly onto images to make spatial coordinates and relative positions explicit within the visual domain.20 | Frisoni et al., "Graph-of-Mark: Promote Spatial Reasoning in Multimodal Language Models with Graph-Based Visual Prompting" (arXiv:2603.06663) 20 | **Medium**: Generating scene graphs locally is computationally intensive on a 5GB GPU setup. | 1 to 2 weeks of work | Improves zero-shot capability in interpreting object positions and relative directions by up to 11%.20 | Composes with visual fallback patterns. |
| **Multi-Turn Reinforcement Self-Correction (SCoRe)**: Trains models to correct their own mistakes over multiple turns using a two-stage reinforcement learning pipeline.21 | Kumar et al., "SCoRe: Multi-Turn Reinforcement Learning for Self-Correction" (arXiv:2410.01235 \[unverified\] / https://openreview.net/forum?id=CjwERcAU7w) 21 | **High**: Can be used offline to align local model checkpoints, preventing the agent from getting stuck in repetitive error loops.21 | 1 to 2 weeks of work | Successfully enables reliable self-correction in LLMs without requiring external models or supervision.21 | Composes with the Evaluator's verification checks. |

## **Sleep-Time and Offline Preparation**

Web browsing sessions suffer from high end-to-end latency when the model must perform both planning and execution during active sessions. Sleep-time compute paradigms address this by utilizing idle client GPU cycles to process long-context documents, optimize episodic memory states, and pre-compute common search paths before a task begins.3  
Background workers use tool executions asynchronously to reorganize memory and pre-populate local cache layers.2

Idle Period (Sleep-Time)  
 \---\> \---\> \---\>  
                                                                                     |  
Active Period (Test-Time)                                                            |  
\[Primary Executor\] \<=================================================================+

| Named Technique | Source Citation | Applicability to Target Edge Stack | Implementation Complexity | Measured Gain | Composition or Conflict with Baseline |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Sleeptime Agents**: Background agent groups that share access to memory blocks, running asynchronously to compile detailed history logs into structured profiles.2 | Lin et al., "Sleep-time Compute: Beyond Inference Scaling at Test-time" (arXiv:2504.13171) 23 | **High**: Extremely useful for edge deployment; allows heavy memory-processing tasks to run while the system is otherwise idle.2 | 5 to 7 days of work | Reduces required active-turn context size; preserves accuracy on complex tasks.2 | Composes with persistent storage databases. |
| **Persistent KV Pre-population & Caching**: Pre-populates and caches KV states for target web pages to Redis during idle periods to eliminate startup latencies.3 | Letta Research / Spheron Network ("Sleep-time Compute") 3 | **High**: Resolves startup delays on complex retailer sites. | 3 to 5 days of work | Reduces TTFT on Qwen models from 5.8s to 0.9s (a 6.4x reduction) over 64K context windows.3 | Composes directly with local Ollama serving parameters. |
| **Auto Dream Execution**: Triggers a consolidation cycle when the model has accumulated a threshold of sessions or idle time, summarizing interaction logs.24 | Anthropic Claude Code (Auto Dream feature, /dream command) 24 | **High**: Extremely simple to adapt via cron jobs or background scripts on the host machine. | 2 to 3 days of work | Automatically organizes local logs 24; reduces search latencies during active sessions.3 | Composes with the browser extension's storage engine. |

## **Agent Loop Architectures Beyond ReAct**

Simple step-by-step action loops often struggle when navigating complex retailer sites because minor execution errors can propagate unchecked.25 To resolve this, agent architectures can integrate structured search trees, allowing the system to explore alternative paths and recover from errors using programmatic rollbacks.

| Named Technique | Source Citation | Applicability to Target Edge Stack | Implementation Complexity | Measured Gain | Composition or Conflict with Baseline |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Language Agent Tree Search (LATS)**: Integrates MCTS with language models to enable structured path selection, node expansion, self-reflection, and backpropagation.26 | Zhou et al., "Language Agent Tree Search Unifies Reasoning, Acting, and Planning in Language Models" (arXiv:2310.04406 / https://github.com/andyzhou123/LATS) 26 | **Low**: Running 5x-20x more model calls per task is too slow and computationally expensive for a local 4B model at 20 tok/s.29 | 1 to 2 weeks of work | Outperforms ReAct on WebShop benchmarks with GPT models, achieving an average score of 75.9.26 | Conflicts with cost-constrained real-time goals.29 |
| **Execution-Feedback MCTS (TabTracer)**: A budget-aware tree search that uses state-hashing, duplicate pruning, and a monotonicity gate to guide exploration and rollback via snapshots.25 | Haffner et al. / TabTracer authors, "TabTracer: Monte Carlo Tree Search for Complex Table Reasoning with Large Language Models" (arXiv:2602.14089) 25 | **Medium**: Backtracking via state snapshots is useful, but recursive evaluations can still strain local model throughput. | 1 to 2 weeks of work | Outperforms state-of-the-art baselines by 6.7% in accuracy while cutting token use by 59% to 84%.30 | Composes with persistent storage for snapshot state rollback. |
| **Reflexion Verb-RL Loop**: A lightweight loop that uses self-generated text feedback to evaluate past failures, updating an explicit reflection buffer before retrying tasks.1 | Shinn et al., "Reflexion: Language Agents with Verbal Reinforcement Learning" (arXiv:2303.11366 / https://github.com/noahshinn/reflexion) \[unverified\] | **High**: Simple textual reflections are lightweight, keeping token overhead minimal on small models.1 | 2 to 3 days of work | Substantially improves accuracy on complex, multi-step agent tasks \[unverified\]. | Composes cleanly with the Evaluator's validation feedback. |

## **Browser-Agent Specific Operations**

Standard web scrapers are too heavy and resource-intensive for local browser extensions. To ensure efficient execution within a 16K context budget, the extension must present the model with a highly dense, semantic page representation. This is achieved by extracting the browser's accessibility (ARIA) tree rather than relying on raw HTML.

Raw HTML:  
\<div class="header-nav-container" id="nav-primary"\>  
  \<button class="btn btn-primary cart-btn" data-id="102"\>  
    \<span class="icon icon-cart"\>\</span\>  
    \<span class="label"\>Shopping Cart (2)\</span\>  
  \</button\>  
\</div\>

ARIA Tree Representation:  
button "Shopping Cart (2)" \[focused: false\]

| Named Technique | Source Citation | Applicability to Target Edge Stack | Implementation Complexity | Measured Gain | Composition or Conflict with Baseline |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Accessibility Tree Context Extraction**: Strips layout code to present a compact, semantic view of page elements, allowing the model to plan batch actions.31 | Anonymous production browser agent findings, "Building Browser Agents: Architecture, Security, and Practical Solutions" (arXiv:2511.19477) 31 | **High**: Drastically reduces raw HTML input sizes, allowing the model to operate efficiently within a 16K context window.31 | 2 to 3 days of work | Enables rapid context parsing; supports programmatic safety constraints over accessibility labels.31 | Composes with DOM adapters. |
| **Environment Sandbox Management (Orchard-GUI)**: Provides Kubernetes-native sandbox lifecycle management and parallel task execution pipelines.33 | Orchard-GUI authors, "Orchard: Scalable Agentic Modeling" (arXiv:2605.15040) 33 | **Low**: Running containerized clusters is far too heavy for a local client-side browser extension. | 2 to 3 weeks of work | Reaches high success rates on long-horizon benchmarks like DeepShop.33 | Conflicts with local resource constraints. |
| **Agent JIT Compilation (JIT-Planner)**: Compiles high-level user goals into structured code plans, avoiding the need to invoke the model on every step of repetitive tasks.34 | Sixiongxie / Agent JIT authors, "Agent JIT Compilation — Efficiency and resource-aware execution" (arXiv ID \[unverified\]) 34 | **High**: Shifting repetitive navigation steps from dynamic prompting to compiled code saves precious edge computing cycles. | 1 to 2 weeks of work | Achieves a 10.4x speedup and a 28% accuracy improvement over standard Browser-Use loops.34 | Composes with the baseline Executor tool definitions. |
| **Secure Agent Sandboxing (ceLLMate)**: Implements isolated browser sandboxes to protect agent executions from malicious prompt injection attacks.35 | ceLLMate authors, "ceLLMate: Sandboxing Browser AI Agents" (arXiv ID \[unverified\]) 35 | **High**: Crucial for client-side security; blocks untrusted retail site scripts from accessing active credentials.35 | 3 to 5 days of work | Successfully sandboxes browser agents, protecting local environments from prompt injections.35 | Composes with local Playwright or Chrome extension environments. |

## **Failure Recovery and Stuck-Loop Detection**

Web browsing environments are highly dynamic. When local agents encounter unexpected bot-detection barriers, structural DOM shifts, or parsing errors, they frequently get stuck in repetitive action loops that exhaust computing budgets. To prevent this, the browser extension must implement tool-layer circuit breakers that monitor execution state and dynamically adjust pathing when progress stalls.

| Named Technique | Source Citation | Applicability to Target Edge Stack | Implementation Complexity | Measured Gain | Composition or Conflict with Baseline |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Tool-Layer Circuit Breakers**: Monitored code wrapper that identifies non-recoverable failures (such as CAPTCHAs or WAF walls) and immediately halts the execution loop.37 | AI Agents community findings, "I just watched my research agent burn $35..." 37 | **High**: Essential for client-side extensions to prevent infinite execution loops and CPU exhaustion.37 | 1 to 2 days of work | Successfully prevents infinite loop conditions by stopping execution on known error signatures.37 | Composes with the baseline Executor tool definitions. |
| **Action-Repetition Penalties**: Programmatic tracking wrapper that monitors the agent's action history, penalizing duplicate steps to force alternative exploration paths.25 | CrewAI / TabTracer loop optimization patterns 25 | **High**: Extremely beneficial for local 4B models, which are prone to repetitive loops when encountering unparseable DOMs. | 1 to 2 days of work | Effectively suppresses duplicate action expansions, ensuring stable forward progress.25 | Composes with the Executor's action log. |
| **Watchdog Progress Detectors**: A secondary monitoring thread that evaluates changes in the page state, validating that actions yield actual progress.37 | AI Agents community 37\[unverified\] | **High**: Simple to implement using basic DOM diffing; does not require model-based checking on every turn. | 2 to 3 days of work | Catch and flag stuck states before they exhaust token and local compute budgets \[unverified\]. | Composes with persistent browser state trackers. |

## **Cost-Aware Planning and Speculative Optimization**

To maintain rapid response times, the local agent must minimize slow, sequential model calls during routine navigation tasks. The Accio (Skim) framework addresses this by profiling retail sites offline to map stable URL structures and layouts.39  
At runtime, the agent speculatively generates the direct destination URL and extracts key data using a lightweight model, bypassing the slow step-by-step browsing loop.39

                \[User Input Query\]  
                        |  
                        v  
         \+-----------------------------+  
         |      Accio Speculation      |  
         \+-----------------------------+  
            /                       \\  
    (Covered / Success)        (Not Covered / Fail)  
          /                           \\  
         v                             v  
              
         |                             ^  
         |                             |  
(Schema Verification)                  |  
         |                             |  
     (Success)                      (Fail)  
       /                             /  
      v                             v  
\[Final Answer\] \--------------\>

| Named Technique | Source Citation | Applicability to Target Edge Stack | Implementation Complexity | Measured Gain | Composition or Conflict with Baseline |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Accio / Skim (Speculative Execution)**: Uses pre-computed URL templates and schema-gated fast paths to bypass step-by-step browsing loops on predictable sites.39 | Wong et al., "Skim: Speculative Execution for Fast and Efficient Web Agents" (arXiv:2605.16565) 39 | **High**: Directly addresses the slow 20 tok/s speed of local models by skipping step-by-step browsing steps on known retail sites. | 1 to 2 weeks of work | Lowers median per-task cost by 1.9x and end-to-end latency by 33.4% without any loss in accuracy.39 | Composes with the Planner as an initial high-speed routing bypass.39 |
| **Monotonicity-Gated State Pruning**: Restricts the search tree by only committing a node when the semantic state genuinely changes, suppressing redundant steps.25 | TabTracer / execution-grounded prioritization 25 | **High**: Keeps local model operations within the strict bounds of the 16K context budget.30 | 3 to 5 days of work | Reduces redundant executions and token usage by up to 84% under a constrained budget.30 | Composes with the persistent IndexedDB state manager. |

## **Breakthrough Paradigms (2025–2026)**

Emerging paradigms focus on training agents to generate their own verification environments and iteratively align their outputs to human preferences.

| Named Technique | Source Citation | Applicability to Target Edge Stack | Implementation Complexity | Measured Gain | Composition or Conflict with Baseline |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Verifiable Environment Synthesis (EvoEnv)**: An algorithmic framework that generates frozen, executable verification environments to provide reliable training signals for reasoning models.43 | EvoEnv authors, "Verifiable Environment Synthesis for Zero-Data Reasoning RL" (arXiv:2605.14392) 43 | **Low**: Generating code execution environments is far too heavy for real-time browser extensions. | Weeks of complex ML engineering | Yields stable reward sources for reinforcement learning pipelines.43 | Conflicts with local resource constraints. |
| **Self-Adapting LLMs (SEAL)**: Allows models to generate their own fine-tuning data and weight-update instructions, reinforcing parameters based on task outcomes.11 | Pari et al., "Self-Adapting LLMs (SEAL)" (https://jyopari.github.io/posts/seal) 11 | **Low**: Modifying raw model weights during live web browsing tasks is highly impractical on a 5GB GPU. | Weeks of ML engineering | Improves question-answering accuracy from 32.7% to 47.0% after two rounds of adaptation.11 | Conflicts with local resource constraints and real-time execution.11 |
| **Iterative Step-Level Preference Optimization (IRPO)**: Optimizes model step generation by creating preference pairs from positive and negative trajectory traces, updating models without expensive manual labels.44 | Pang et al., "Iterative Step-Level Preference Optimization" (https://openreview.net/forum?id=4XIKfvNYvx \[unverified\]) 44 | **Medium**: Training local models is highly complex; can be used offline to align local model checkpoints for web use. | 1 to 2 weeks of work | Enhances step-by-step deduction capabilities over multi-iteration training runs.44 | Composes with the baseline as an offline, session-to-session model optimization step. |

## **System Integration and Synthesis**

To deliver highly reliable, cost-effective shopping search operations within a strict 16K context budget, the browser extension must prioritize techniques that maximize execution speed and simplify page inputs over complex, recursive planning loops.

                  \[User Input Query\]  
                          |  
                          v  
         \+----------------------------------+  
         |     1\. Accio Speculation Loop     | \===== (Success) \=====\> \[Extract & Verify\]  
         \+----------------------------------+                                |  
                          |                                                  |  
                      (Fallback)                                             |  
                          v                                                  v  
         \+----------------------------------+                        \[Format Output\]  
         | 2\. Telegraph English Compression |  
         \+----------------------------------+  
                          |  
                          v  
         \+----------------------------------+  
         |   3\. ARIA Tree DOM Extraction    |  
         \+----------------------------------+  
                          |  
                          v  
         \+----------------------------------+  
         |     4\. Executor Loop \+           |  
         |        Watchdog Circuit          |  
         \+----------------------------------+

### **1\. Accio / Skim Speculative Execution**

* **Concrete Capability Added**: Bypass the slow step-by-step browsing loop by matching common search tasks against pre-computed URL structures and schemas.39 This collapses multi-turn navigation into direct, high-speed page extraction.39  
* **Baseline Composition**: Operates as a fast routing layer before invoking the primary ReAct execution path.39 This minimizes inference demands on the local 20 tok/s execution loop, freeing up GPU memory for necessary tasks.39  
* **What to Deprioritize**: Deprioritize recursive planning approaches like Language Agent Tree Search (LATS). These methods are computationally heavy, require multiple model calls per turn, and are too slow for real-time edge use.29

### **2\. Telegraph English (TE) Semantic Compression**

* **Concrete Capability Added**: Translates raw page data into a dense, symbolic atomic dialect.1 This process packs complex page facts into a small fraction of the 16K context window, preventing context overflow during multi-step runs.14  
* **Baseline Composition**: Composes cleanly with the existing DOM adapters. Instead of passing raw adapter JSON straight to the model, the data is routed through a localized TE translator step. This structured, symbolic representation provides clear relational signals that help the local 4B model track details accurately.14  
* **What to Deprioritize**: Deprioritize standard token-deletion models (such as LLMLingua-2). These methods produce fragmented, ungrammatical text that often degrades the parsing accuracy of smaller local models.14

### **3\. ARIA Tree Extraction**

* **Concrete Capability Added**: Extracts the browser's accessibility (ARIA) tree instead of raw HTML structures.31 This provides the local model with a clean, semantic representation of the page layout, minimizing input size.31  
* **Baseline Composition**: Directly integrates into the DOM adapters.31 The Executor parses accessibility tree snapshots for primary action planning and reserves visual screenshots strictly for fallback verification checks.31  
* **What to Deprioritize**: Deprioritize continuous visual grounding helpers like Graph-of-Mark. Generating these visual graph overlays on every execution turn places excessive strain on a local 5GB GPU setup.20

### **4\. Stuck-Loop Watchdogs & Circuit Breakers**

* **Concrete Capability Added**: Monitors tool execution state to identify repetitive action loops or non-recoverable blockages (such as WAF walls), immediately halting execution to protect client resources.37  
* **Baseline Composition**: Operates as a wrapper around Executor tool calls, protecting the primary Planner from getting stuck in expensive, infinite retry loops.37  
* **What to Deprioritize**: Deprioritize open-ended model self-correction loops. A local 4B model lacks the diagnostic depth to resolve execution blockages on its own, often leading to hallucinatory retries.37

### **5\. Sleep-Time KV Cache Prefetching**

* **Concrete Capability Added**: Utilizes idle system cycles to pre-populate local Redis KV caches for target shopping portals.3 This prefill step drastically reduces Time-To-First-Token (TTFT) delays when the user initiates a search.3  
* **Baseline Composition**: Runs silently in the background of the browser extension, writing pre-populated cache states to the local Ollama instance.3  
* **What to Deprioritize**: Deprioritize complex, real-time context management during active tasks. Shifting pre-processing workloads to idle periods minimizes the computing footprint during active sessions.3

Implementing weight-modifying self-adaptation frameworks, such as SEAL, should not be attempted, because executing local model fine-tuning and weight updates during active browsing sessions introduces massive latency and resource contention on consumer hardware.

#### **Works cited**

1. Telegraph English: Semantic Prompt Compression via Structured Symbolic Rewriting \- arXiv, accessed May 23, 2026, [https://arxiv.org/html/2605.04426v1](https://arxiv.org/html/2605.04426v1)  
2. Sleep-time agents | Letta Docs, accessed May 23, 2026, [https://docs.letta.com/guides/agents/architectures/sleeptime/](https://docs.letta.com/guides/agents/architectures/sleeptime/)  
3. Sleep-Time Compute on GPU Cloud: Pre-Compute Long-Lived Context for 5x Lower Query Latency | Spheron Blog, accessed May 23, 2026, [https://www.spheron.network/blog/sleep-time-compute-gpu-cloud/](https://www.spheron.network/blog/sleep-time-compute-gpu-cloud/)  
4. A Systematic Survey of Self-Evolving Agents: From Model-Centric to Environment-Driven Co-Evolution \- ResearchGate, accessed May 23, 2026, [https://www.researchgate.net/publication/401016261\_A\_Systematic\_Survey\_of\_Self-Evolving\_Agents\_From\_Model-Centric\_to\_Environment-Driven\_Co-Evolution](https://www.researchgate.net/publication/401016261_A_Systematic_Survey_of_Self-Evolving_Agents_From_Model-Centric_to_Environment-Driven_Co-Evolution)  
5. AgentTrek: Agent Trajectory Synthesis via Guiding Replay with Web Tutorials \- OpenReview, accessed May 23, 2026, [https://openreview.net/forum?id=EEgYUccwsV](https://openreview.net/forum?id=EEgYUccwsV)  
6. AgentTrek: Agent Trajectory Synthesis via Guiding Replay with Web Tutorials, accessed May 23, 2026, [https://agenttrek.github.io/](https://agenttrek.github.io/)  
7. \[2412.09605\] AgentTrek: Agent Trajectory Synthesis via Guiding Replay with Web Tutorials, accessed May 23, 2026, [https://arxiv.org/abs/2412.09605](https://arxiv.org/abs/2412.09605)  
8. xlangai/AgentTrek · Datasets at Hugging Face, accessed May 23, 2026, [https://huggingface.co/datasets/xlangai/AgentTrek](https://huggingface.co/datasets/xlangai/AgentTrek)  
9. VideoAgentTrek: Computer Use Pretraining from Unlabeled Videos \- arXiv, accessed May 23, 2026, [https://arxiv.org/html/2510.19488v1](https://arxiv.org/html/2510.19488v1)  
10. Papers Explained 302: ReST^EM \- Ritvik Rastogi, accessed May 23, 2026, [https://ritvik19.medium.com/papers-explained-302-rest-em-9abe7c76936e](https://ritvik19.medium.com/papers-explained-302-rest-em-9abe7c76936e)  
11. Self-Adapting Language Models \- Jyo Pari, accessed May 23, 2026, [https://jyopari.github.io/posts/seal](https://jyopari.github.io/posts/seal)  
12. Beyond Human Data: Scaling Self-Training for Problem-Solving with Language Models, accessed May 23, 2026, [https://www.cs.toronto.edu/\~cmaddis/courses/csc2541\_w25/presentations/bansal\_%20muraleedharan\_restem.pdf](https://www.cs.toronto.edu/~cmaddis/courses/csc2541_w25/presentations/bansal_%20muraleedharan_restem.pdf)  
13. \[2403.12968\] LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression \- arXiv, accessed May 23, 2026, [https://arxiv.org/abs/2403.12968](https://arxiv.org/abs/2403.12968)  
14. Telegraph English: Semantic Prompt Compression via Structured Symbolic Rewriting \- arXiv, accessed May 23, 2026, [https://arxiv.org/abs/2605.04426](https://arxiv.org/abs/2605.04426)  
15. LLMLingua: Compressing Prompts for Accelerated Inference of Large Language Models, accessed May 23, 2026, [https://openreview.net/forum?id=ADsEdyI32n\&referrer=\\%5Bthe\\%20profile\\%20of\\%20Yuqing\\%20Yang\\%5D(\\%2Fprofile\\%3Fid\\%3DYuqing\_Yang1)](https://openreview.net/forum?id=ADsEdyI32n&referrer=%5C%5Bthe%5C+profile%5C+of%5C+Yuqing%5C+Yang%5C%5D\(%5C/profile%5C?id%5C%3DYuqing_Yang1\))  
16. Compressing Prompts for Accelerated Inference of Large Language Models \- LLMLingua, accessed May 23, 2026, [https://llmlingua.com/llmlingua.html](https://llmlingua.com/llmlingua.html)  
17. LLMLingua: Compressing Prompts for Accelerated Inference of Large Language Models, accessed May 23, 2026, [https://www.researchgate.net/publication/376394519\_LLMLingua\_Compressing\_Prompts\_for\_Accelerated\_Inference\_of\_Large\_Language\_Models](https://www.researchgate.net/publication/376394519_LLMLingua_Compressing_Prompts_for_Accelerated_Inference_of_Large_Language_Models)  
18. Seg-Agent: Test-Time Multimodal Reasoning for Training-Free Language-Guided Segmentation \- arXiv, accessed May 23, 2026, [https://arxiv.org/html/2605.12953v1](https://arxiv.org/html/2605.12953v1)  
19. \[2310.11441\] Set-of-Mark Prompting Unleashes Extraordinary Visual Grounding in GPT-4V, accessed May 23, 2026, [https://arxiv.org/abs/2310.11441](https://arxiv.org/abs/2310.11441)  
20. \[2603.06663\] Graph-of-Mark: Promote Spatial Reasoning in Multimodal Language Models with Graph-Based Visual Prompting \- arXiv, accessed May 23, 2026, [https://arxiv.org/abs/2603.06663](https://arxiv.org/abs/2603.06663)  
21. Training Language Models to Self-Correct via Reinforcement Learning \- OpenReview, accessed May 23, 2026, [https://openreview.net/forum?id=CjwERcAU7w](https://openreview.net/forum?id=CjwERcAU7w)  
22. Sleep-time Compute | Letta, accessed May 23, 2026, [https://www.letta.com/blog/sleep-time-compute](https://www.letta.com/blog/sleep-time-compute)  
23. Sleep-time Compute: Beyond Inference Scaling at Test-time \- arXiv, accessed May 23, 2026, [https://arxiv.org/html/2504.13171v1](https://arxiv.org/html/2504.13171v1)  
24. Your AI Coding Agent now needs sleep — here's what /dream actually does | by Daniel Braz, accessed May 23, 2026, [https://levelup.gitconnected.com/your-ai-coding-agent-now-needs-sleep-heres-what-dream-actually-does-81d32977ec25](https://levelup.gitconnected.com/your-ai-coding-agent-now-needs-sleep-heres-what-dream-actually-does-81d32977ec25)  
25. TabTracer: Monte Carlo Tree Search for Complex Table Reasoning with Large Language Models \- arXiv, accessed May 23, 2026, [https://arxiv.org/pdf/2602.14089](https://arxiv.org/pdf/2602.14089)  
26. Language Agent Tree Search Unifies Reasoning, Acting, and Planning in Language Models \- arXiv, accessed May 23, 2026, [https://arxiv.org/pdf/2310.04406](https://arxiv.org/pdf/2310.04406)  
27. Language Agent Tree Search Unifies Reasoning, Acting, and Planning in Language Models \- arXiv, accessed May 23, 2026, [https://arxiv.org/html/2310.04406v3](https://arxiv.org/html/2310.04406v3)  
28. \[2310.04406\] Language Agent Tree Search Unifies Reasoning Acting and Planning in Language Models \- arXiv, accessed May 23, 2026, [https://arxiv.org/abs/2310.04406](https://arxiv.org/abs/2310.04406)  
29. Language Agent Tree Search (LATS) \- Agentic Patterns, accessed May 23, 2026, [https://agentic-patterns.com/patterns/language-agent-tree-search-lats/](https://agentic-patterns.com/patterns/language-agent-tree-search-lats/)  
30. (PDF) TabTracer: Monte Carlo Tree Search for Complex Table Reasoning with Large Language Models \- ResearchGate, accessed May 23, 2026, [https://www.researchgate.net/publication/400854881\_TabTracer\_Monte\_Carlo\_Tree\_Search\_for\_Complex\_Table\_Reasoning\_with\_Large\_Language\_Models](https://www.researchgate.net/publication/400854881_TabTracer_Monte_Carlo_Tree_Search_for_Complex_Table_Reasoning_with_Large_Language_Models)  
31. Building Browser Agents: Architecture, Security, and Practical Solutions \- arXiv, accessed May 23, 2026, [https://arxiv.org/html/2511.19477v1](https://arxiv.org/html/2511.19477v1)  
32. (PDF) Building Browser Agents: Architecture, Security, and Practical Solutions, accessed May 23, 2026, [https://www.researchgate.net/publication/397982931\_Building\_Browser\_Agents\_Architecture\_Security\_and\_Practical\_Solutions](https://www.researchgate.net/publication/397982931_Building_Browser_Agents_Architecture_Security_and_Practical_Solutions)  
33. Orchard: An Open-Source Agentic Modeling Framework \- arXiv, accessed May 23, 2026, [https://arxiv.org/html/2605.15040v2](https://arxiv.org/html/2605.15040v2)  
34. AI agent benchmarks and eval trends \- Scouts by Yutori, accessed May 23, 2026, [https://scouts.yutori.com/ab86f937-6355-4cb2-a74f-ca94c5df744d](https://scouts.yutori.com/ab86f937-6355-4cb2-a74f-ca94c5df744d)  
35. Daily Papers \- Hugging Face, accessed May 23, 2026, [https://huggingface.co/papers?q=headless%20browser%20execution](https://huggingface.co/papers?q=headless+browser+execution)  
36. The Hidden Dangers of Browsing AI Agents \- arXiv, accessed May 23, 2026, [https://arxiv.org/html/2505.13076v1](https://arxiv.org/html/2505.13076v1)  
37. I just watched my research agent burn $35 in an infinite loop. Turns out, it wasn't a prompt issue. : r/AI\_Agents \- Reddit, accessed May 23, 2026, [https://www.reddit.com/r/AI\_Agents/comments/1s42cfo/i\_just\_watched\_my\_research\_agent\_burn\_35\_in\_an/](https://www.reddit.com/r/AI_Agents/comments/1s42cfo/i_just_watched_my_research_agent_burn_35_in_an/)  
38. Agents keeps going in a loop \- Crews \- CrewAI, accessed May 23, 2026, [https://community.crewai.com/t/agents-keeps-going-in-a-loop/1053](https://community.crewai.com/t/agents-keeps-going-in-a-loop/1053)  
39. Accio: Speculative Execution for Fast and Efficient Web Agents \- arXiv, accessed May 23, 2026, [https://arxiv.org/html/2605.16565v1](https://arxiv.org/html/2605.16565v1)  
40. \[2605.16565\] Skim: Speculative Execution for Fast and Efficient Web Agents \- arXiv, accessed May 23, 2026, [https://arxiv.org/abs/2605.16565](https://arxiv.org/abs/2605.16565)  
41. Skim: Speculative Execution for Fast and Efficient Web Agents \- ResearchGate, accessed May 23, 2026, [https://www.researchgate.net/publication/404991156\_Skim\_Speculative\_Execution\_for\_Fast\_and\_Efficient\_Web\_Agents](https://www.researchgate.net/publication/404991156_Skim_Speculative_Execution_for_Fast_and_Efficient_Web_Agents)  
42. TabTracer: Monte Carlo Tree Search for Complex Table Reasoning with Large Language Models \- arXiv, accessed May 23, 2026, [https://arxiv.org/html/2602.14089v1](https://arxiv.org/html/2602.14089v1)  
43. Learning to Build the Environment: Self-Evolving Reasoning RL via Verifiable Environment Synthesis \- arXiv, accessed May 23, 2026, [https://arxiv.org/html/2605.14392v1](https://arxiv.org/html/2605.14392v1)  
44. Iterative Reasoning Preference Optimization \- OpenReview, accessed May 23, 2026, [https://openreview.net/forum?id=4XIKfvNYvx¬eId=wLLnPIt7GL](https://openreview.net/forum?id=4XIKfvNYvx&noteId=wLLnPIt7GL)