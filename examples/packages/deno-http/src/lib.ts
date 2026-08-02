export const tokens = {
  subjects: [
    'You',
    'The version of you they approved',
    'The man staring back from the mirror',
    'The consumer they built you to be',
    'Your fear of being nobody',
    'The life you keep postponing',
    'The animal underneath the resume',
  ],
  verbs: [
    'is chasing',
    'is addicted to',
    'is hiding behind',
    'is slowly becoming',
    'is terrified of losing',
    'mistakes for freedom',
    'calls success',
  ],
  objects: [
    'a life that was never yours',
    'approval from strangers',
    'a job that owns your time',
    "things you don't need",
    'a story someone else wrote',
    'comfort dressed up as purpose',
    'a cage with better lighting',
  ],
  modifiers: [
    'and wonders why it feels empty',
    'while calling it progress',
    'because silence feels dangerous',
    'so you never have to be alone with yourself',
    'and you know it',
    'but you keep buying anyway',
    "and that's the joke",
  ],
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export const Utils = { pick, capitalize };
