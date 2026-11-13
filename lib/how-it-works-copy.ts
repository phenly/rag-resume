import type { RetrievalStrategy } from './retrieval/load';

/** Which answering mode the How it Works page describes: the configured one, so the page cannot drift from the deployment. */
export type HowItWorksMode = 'whole' | 'wide' | 'jev';

export type HowItWorksBox = { title: string; note: string };

/** One titled block of the page. `diagram` places the flow diagram under the title; `steps` render as a numbered list. */
export type HowItWorksSection = { title: string; diagram?: boolean; paragraphs?: string[]; steps?: string[]; bullets?: string[] };

export type HowItWorksCopy = {
  /** The per-question flow. */
  boxes: HowItWorksBox[];
  /** When present, the diagram gains a first row for the work done before any question, linked to the second box of the flow. */
  indexBoxes?: HowItWorksBox[];
  diagramLabel: string;
  sections: HowItWorksSection[];
  privacy: string[];
  next: { title: string; text: string }[];
};

export function howItWorksMode(approach: 'whole' | 'rag', strategy: RetrievalStrategy): HowItWorksMode {
  return approach === 'whole' ? 'whole' : strategy;
}

const SHARE_WARNING =
  'Please avoid sharing confidential or sensitive information in your questions. These services process the text under their account terms; CV-AI does not promise that they immediately delete it.';

const COMMON_NEXT = [
  { title: 'Guardrails', text: 'Stronger, tested checks that keep private or off-topic material out of answers.' },
  { title: 'A question log', text: 'Record which questions people ask so the archive can fill the gaps.' },
];

const FIRST_STEP = 'Your question is sent to the server hosting CV-AI, along with the earlier turns of this conversation.';
const LAST_STEP = 'The answer streams back to you as it is written.';
const RULES_STEP =
  'The rules tell Claude to stay within what it was given, to keep private topics private and to decline requests that are not about the candidate’s career.';

export function howItWorksCopy(mode: HowItWorksMode): HowItWorksCopy {
  if (mode === 'whole') {
    return {
      boxes: [
        { title: '1. Your question', note: 'Typed in the browser' },
        { title: '2. The server', note: 'Attaches the whole career archive and the answer rules' },
        { title: '3. Claude', note: 'Reads the archive and writes an answer' },
        { title: '4. Streamed answer', note: 'Appears word by word' },
      ],
      diagramLabel:
        'Flow diagram: your question goes to the server, which sends it with the whole career archive and answer rules to Claude, and the answer streams back.',
      sections: [{ title: 'From question to answer', diagram: true, steps: [
        FIRST_STEP,
        'The server attaches the entire career archive, a short public profile and a set of answer rules. Nothing is searched or filtered: every question is answered against the same full archive.',
        `Claude reads all of it and writes an answer. ${RULES_STEP}`,
        LAST_STEP,
      ] }],
      privacy: [
        'Anthropic (Claude) receives your question, the accepted history of this conversation and the career archive. No other service receives your questions.',
        'A search index of the archive is also built with Voyage AI for a retrieval version that is being tested. It is not used to answer you here, and building it involves only the career archive.',
        SHARE_WARNING,
      ],
      next: [
        {
          title: 'Search before answering',
          text: 'A version that finds the relevant passages first, instead of sending the whole archive, is built and being measured against this one.',
        },
        ...COMMON_NEXT,
      ],
    };
  }
  if (mode === 'wide') {
    return {
      indexBoxes: [
        { title: 'Career notes', note: 'Written and checked by the candidate' },
        { title: 'Passages', note: 'One piece of work each, private details removed by code' },
        { title: 'Embeddings', note: 'Each passage becomes a list of numbers' },
        { title: 'Saved index', note: 'One file, shipped with the site' },
      ],
      boxes: [
        { title: 'Your question', note: 'Plus recent conversation context' },
        { title: 'Search', note: 'Embed the question, rank every passage by similarity' },
        { title: 'Evidence', note: 'Timeline, role summaries and the 40 closest passages' },
        { title: 'Claude', note: 'Reads the evidence, streams an answer' },
      ],
      diagramLabel:
        'Two-row diagram. Before any question: career notes are cleaned into passages, each passage is turned into an embedding, and the result is saved as an index. On every question: the question is embedded and every passage in the saved index is ranked by similarity; a career timeline, role summaries and the 40 closest passages go to Claude with answer rules, and the answer streams back.',
      sections: [
        {
          title: 'Two jobs, run at different times',
          diagram: true,
          paragraphs: [
            'CV-AI is a retrieval system: Claude never sees the whole career archive, only the parts that match your question. That splits the work in two. The top row runs once, whenever the career notes change. The bottom row runs on every question. The only link between them is the saved index.',
          ],
        },
        {
          title: 'Before any question: building the index',
          paragraphs: [
            'The archive starts as career notes with one entry per piece of work: a product launch, a reorganization, a result. An export step turns each entry into a short passage, and that step is the privacy layer. It is code that can be tested, not an instruction Claude is trusted to follow.',
          ],
          bullets: [
            'Entries not cleared for the chatbot are dropped, along with internal notes and source references.',
            'Customer names are replaced with generic descriptions unless the work is already public, and colleagues are replaced with their roles.',
            'Each passage gets a context line (company, role, years) so it still makes sense when read alone.',
            'Guidance attached to an entry, such as a claim never to make, travels with its passage to Claude but is not part of what gets searched.',
            'An embedding model (Voyage AI’s voyage-4-large) then converts each passage into a list of 1,024 numbers. Passages and numbers are saved in one file that ships with the site. At this size a vector database would add a moving part and no benefit.',
          ],
        },
        {
          title: 'What an embedding is',
          paragraphs: [
            'An embedding model reads a piece of text and returns a fixed-length list of numbers. Treat the list as coordinates: a point in a “meaning space.” The model is trained so that texts about similar things land near each other even when they share no words, so a question about putting generative AI in front of real users lands near a passage about an analytics assistant that never uses the phrase “real users.”',
            'Finding the right passages then becomes geometry. Embed the question with the same model and measure how close each passage sits to it. Closeness is cosine similarity, the angle between two lists of numbers: 1 means the same direction, 0 means unrelated. It is a multiply-and-add per number, so scoring every passage in the archive happens in memory on the server, with no search service involved.',
          ],
        },
        {
          title: 'When you ask a question',
          steps: [
            'Your question goes to the server with the earlier turns of this conversation. Earlier turns are accepted only if they carry a signature the server issued, so history cannot be forged to steer the answer.',
            'The server builds a search query from the question and a limited amount of recent context, so a follow-up like “tell me more about that” still searches for the right thing. Voyage AI embeds the query.',
            'Every passage is scored against the query and ranked. Nothing is pre-filtered and nothing is guessed from keywords.',
            'The evidence is assembled. A career timeline and a summary of each role are included on every question, because broad questions such as “how many years of experience?” are not close to any single passage. The 40 closest remaining passages are added.',
            'Claude receives that evidence, a short public profile and the answer rules, and writes the answer. The rules tell it to stay within the evidence, keep private topics private and decline requests that are not about the candidate’s career.',
            'The answer streams back as it is written. Search adds about a fifth of a second in testing; most of the wait is Claude writing.',
          ],
        },
        {
          title: 'What it deliberately leaves out',
          bullets: [
            'No fallback to the whole archive. If search fails, you get a short “can’t answer right now” message instead of a guess or a silent switch to a different method.',
            'No reranker or second model judging relevance. An earlier design had one; measurement showed it added calls, delay and complexity without clearly better evidence.',
            'No keyword search in what Claude sees. Keyword matches are computed alongside the embedding ranking and recorded for measurement, and so far they have not surfaced anything the ranking missed.',
          ],
        },
        {
          title: 'How it is tested',
          paragraphs: [
            'Each test question lists the passages a good answer needs. That makes retrieval measurable on its own, separately from whether the answer reads well: did the right evidence reach Claude? A second set of checks grades the answers, including questions designed to extract private material or push the assistant off topic. Both sets are rerun when the retrieval settings change.',
          ],
        },
      ],
      privacy: [
        'Anthropic (Claude) receives your question, the accepted history of this conversation and the selected career evidence. Voyage AI receives your question and a limited amount of recent conversation context to run the search, and processes the career archive when the search index is built.',
        SHARE_WARNING,
      ],
      next: COMMON_NEXT,
    };
  }
  return {
    boxes: [
      { title: '1. Your question', note: 'Typed in the browser' },
      { title: '2. The server', note: 'Chooses career evidence and adds answer rules' },
      { title: '3. Claude', note: 'Reads career evidence and writes an answer' },
      { title: '4. Streamed answer', note: 'Appears word by word' },
    ],
    diagramLabel:
      'Flow diagram: your question goes to the server, which selects career evidence and sends it with answer rules to Claude, and the answer streams back.',
    sections: [{ title: 'From question to answer', diagram: true, steps: [
      FIRST_STEP,
      'The server searches the career archive for relevant passages and checks whether they are enough to answer. If they are not, it can send the whole archive when it fits. A short public profile and a set of answer rules go with either.',
      `Claude reads the supplied evidence and writes an answer. Some private or out-of-scope questions receive a short prepared response. ${RULES_STEP}`,
      LAST_STEP,
    ] }],
    privacy: [
      'Anthropic (Claude) receives your question, the accepted history of this conversation and the career evidence used to answer. Voyage AI receives your question and a limited amount of recent conversation context to find relevant material, and processes the career archive when the search index is built. TypeSafe receives the question, that context, candidate passages and answer rules to check relevance and whether there is enough evidence.',
      SHARE_WARNING,
    ],
    next: COMMON_NEXT,
  };
}
