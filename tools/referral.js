
const LN_2 = Math.log(2);
console.log(LN_2, 1/LN_2);

const outstandingRent = 13*12;
const totalRent = 13 + outstandingRent;
const T = Math.sqrt(totalRent);
// const T = totalRent;
console.log(`T: ${T}`);
const levelCount = 8;
const levelStep = T / levelCount;
console.log(`level step: ${levelStep}`);

const rents = [
  [12,1],
  [6,6,1],
  [4,4,4,1],
  [3,3,3,3,1],
  [2,2,2,2,2,2,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1],
];

for (const rent of rents) {
  console.log(`\n${rent}`);
  let remain = 32;
  for (let r of rent) {
    console.log(`r: ${r.toFixed(2)}`);
    const a = r/levelStep;
    const y0 = remain * LN_2;
    // remain is the area under y = y0 / 2^x
    // y0 = remain * ln(2)
    // a = r/step
    // reward = y0 * integral(1/2^x) for x = [0,a]
    // reward = y0 * (1-1/2^a) / ln(2) = remain * (1-1/2^a)
    const reward = remain*(1-1/Math.pow(2,a));
    remain -= reward;

    // let reward = 0;
    // while (r >= levelStep) {
    //   r -= levelStep;
    //   remain /= 2;
    //   reward += remain;
    // }
    // if (r > 0) {
    //   const partial = (r / levelStep) * remain / 2;
    //   reward += partial
    //   remain -= partial;
    // }
    console.log(`reward: ${reward.toFixed(2)}, remain: ${remain.toFixed(2)}`);
  }
}
