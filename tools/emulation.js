
const nodes = [
  {
    parent: -1,
  }
];

for (let i = 0; i < 1000; ++i) {
  nodes.push({
    parent: Math.floor(Math.random() * nodes.length),
    rent: Math.random(),
  })
}

const outstandingRent = 13*12;
const totalRent = 13 + outstandingRent;
const T = Math.sqrt(totalRent);
// const T = totalRent;
console.log(`T: ${T}`);
const levelCount = 8;
const S = T / levelCount;
console.log(`level step: ${S}`);

const rents = [
  [12],
  [6,6],
  [4,4,4],
  [3,3,3,3],
  [12,0,0,0],
  [0,0,0,12],
  [2,2,2,2,2,2],
  [1,1,1,1,1,1,1,1,1,1,1,1],
];

function nextRemain(remain, r) {
  return remain / Math.pow(2,r/S);
}

function nextReward(remain, r) {
  return remain - nextRemain(remain, r);
}

for (const rent of rents) {
  console.log(`\n${rent}`);
  let remain = 32;
  for (let r of rent) {
    // console.log(`r: ${r.toFixed(2)}`);
    // const y0 = remain * LN_2;
    // remain is the area under y = y0 / 2^x
    // y0 = remain * ln(2)
    // a = r/step
    // reward = y0 * integral(1/2^x) for x = [0,a]
    // reward = y0 * (1-1/2^a) / ln(2) = remain * (1-1/2^a)
    const reward = nextReward(remain, r);
    remain -= reward;
    // console.log(`reward: ${reward.toFixed(2)}, remain: ${remain.toFixed(2)}`);
  }
  console.log(`remain: ${remain.toFixed(2)}`)
}
