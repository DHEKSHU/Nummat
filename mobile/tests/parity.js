const E=require('../src/engine.js');
const cases=require(process.argv[2]); let bad=0;
const S=(x)=>JSON.stringify(x);
for (const [i,c] of cases.entries()) {
  const pairs=E.findPairs(c.g,c.f).map(([a,b,k])=>[a,b,k]);
  if (S(pairs)!==S(c.pairs)) { bad++; if(bad<5) console.log('pairs',i,S(pairs),S(c.pairs)); }
  if (c.move) {
    const d=E.applyMoveDetailed(c.g,c.f,c.move[0],c.move[1],c.collapse);
    const out={grid:d.grid,frozen:d.frozen.map(p=>[p[0],p[1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]),cleared:d.cleared.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]),powers:d.powers.map(p=>p[0]),rows_removed:d.rows_removed};
    if (S(out)!==S(c.out)) { bad++; if(bad<5) console.log('move',i,S(out),'\n   py',S(c.out)); }
    const k=E.connection(c.g,c.move[0],c.move[1]);
    const ex=E.explainMove(c.g,c.f,c.move[0],c.move[1],k,0,1,0,c.collapse);
    const un=ex.unlocked.map(p=>[p[0],p[1]].sort((a,b)=>a[0]-b[0]||a[1]-b[1])).sort((a,b)=>S(a)<S(b)?-1:1);
    const pyun=c.unlocked.slice().sort((a,b)=>S(a)<S(b)?-1:1);
    if (S(un)!==S(pyun)||ex.difficulty_impact!==c.delta) { bad++; if(bad<5) console.log('unlocked',i,S(un),S(pyun)); }
  }
  const ar=E.addRows(c.g); if (S(ar)!==S(c.add)) { bad++; if(bad<5) console.log('add',i,S(ar),S(c.add)); }
  if ('solve' in c) { const r=E.solve(c.g,c.f,3000,c.collapse).solvable; if (r!==c.solve) { bad++; if(bad<8) console.log('solve',i,r,c.solve); } }
}
console.log(bad? bad+' MISMATCHES' : 'PARITY OK: '+cases.length+' random boards identical in Python and JS');
