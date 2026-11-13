import type { RetrievalStrategy } from './retrieval/load';

/** Which answering mode the How it Works page describes: the configured one, so the page cannot drift from the deployment. */
export type HowItWorksMode = 'whole' | 'wide' | 'jev';

export type HowItWorksCopy = {
  boxes: { title: string; note: string }[];
  diagramLabel: string;
  steps: string[];
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
      steps: [
        FIRST_STEP,
        'The server attaches the entire career archive, a short public profile and a set of answer rules. Nothing is searched or filtered: every question is answered against the same full archive.',
        `Claude reads all of it and writes an answer. ${RULES_STEP}`,
        LAST_STEP,
      ],
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
      boxes: [
        { title: '1. Your question', note: 'Typed in the browser' },
        { title: '2. The server', note: 'Searches the archive for the closest passages and adds answer rules' },
        { title: '3. Claude', note: 'Reads the selected evidence and writes an answer' },
        { title: '4. Streamed answer', note: 'Appears word by word' },
      ],
      diagramLabel:
        'Flow diagram: your question goes to the server, which searches the career archive and sends the closest passages with answer rules to Claude, and the answer streams back.',
      steps: [
        FIRST_STEP,
        'The server turns your question into a search query and ranks every passage in the career archive by how close its meaning is. It sends Claude a career timeline and a summary of each role on every question, plus the 40 closest passages, a short public profile and a set of answer rules.',
        `Claude reads that evidence and writes an answer. ${RULES_STEP}`,
        `${LAST_STEP} If the search cannot run, you get a short “can’t answer right now” message instead of a guess.`,
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
    steps: [
      FIRST_STEP,
      'The server searches the career archive for relevant passages and checks whether they are enough to answer. If they are not, it can send the whole archive when it fits. A short public profile and a set of answer rules go with either.',
      `Claude reads the supplied evidence and writes an answer. Some private or out-of-scope questions receive a short prepared response. ${RULES_STEP}`,
      LAST_STEP,
    ],
    privacy: [
      'Anthropic (Claude) receives your question, the accepted history of this conversation and the career evidence used to answer. Voyage AI receives your question and a limited amount of recent conversation context to find relevant material, and processes the career archive when the search index is built. TypeSafe receives the question, that context, candidate passages and answer rules to check relevance and whether there is enough evidence.',
      SHARE_WARNING,
    ],
    next: COMMON_NEXT,
  };
}
