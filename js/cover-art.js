// 構図の選択と描画を分離し、選択済みの構図を記事ごとに保持する。
const PastelCover = (() => {
  const version = 'composition-v2';
  const patterns = Object.freeze([
    '円とくさび', '開いたリング', '斜めのリボン', '向かい合う扇形', '階段と軌道',
    '切り欠きと交差', '浮かぶ菱形', '大きなアーチ', 'ずれた平行面', '扇と小さな島'
  ]);
  function pickPattern(recent, rng = Math.random) {
    const excluded = new Set(recent.slice(-3));
    const choices = patterns.map((_,i) => i).filter(i => !excluded.has(i));
    return choices[Math.floor(rng() * choices.length)];
  }
  const paper = '#FAF7EF', navy = '#273850';
  const pastels = ['#90D7E2','#F1A7C4','#EFE59B','#E8BAA6','#B7BEE5','#BFD8CA'];
  function hash(text) {
    let h = 2166136261;
    for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function random(seed) {
    return () => {
      seed = (seed + 0x6D2B79F5) >>> 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function render(articleId, aspect = 3, variation = 0, patternId = null) {
    const seed = hash(`${version}:${articleId}:${variation}`), rng = random(seed);
    const width = 1200, height = Math.round(width / Math.max(1.5, Math.min(9, aspect)));
    const n = value => Number(value.toFixed(2));
    const x = value => n(width * value), y = value => n(height * value);
    const mix = (a,b) => a + rng() * (b-a);
    const palette = pastels.slice();
    for (let i=palette.length-1;i>0;i--) { const j=Math.floor(rng()*(i+1)); [palette[i],palette[j]]=[palette[j],palette[i]]; }
    const [a,b,c,d] = palette;
    const recipe = patternId ?? seed % patterns.length, mirror = rng() > .5;
    if (!Number.isInteger(recipe) || recipe < 0 || recipe >= patterns.length) throw new RangeError('Unknown pattern');
    let layers = '';
    const polygon = (points, fill) => `<polygon points="${points.map(([u,v])=>`${x(u)},${y(v)}`).join(' ')}" fill="${fill}"/>`;
    const rect = (u,v,w,h,fill) => `<rect x="${x(u)}" y="${y(v)}" width="${x(w)}" height="${y(h)}" fill="${fill}"/>`;
    const circle = (u,v,r,fill) => `<circle cx="${x(u)}" cy="${y(v)}" r="${n(r)}" fill="${fill}"/>`;
    const radius = Math.min(height*.91, width*.235);
    const arc = (u,v,r,color) => `<circle cx="${x(u)}" cy="${y(v)}" r="${n(r)}" fill="none" stroke="${color}" stroke-width="${n(r*.34)}"/>`;
    const staircase = (u,v,size,color) => `<path d="M0 ${n(size)}V0H${n(size/3)}V${n(size/3)}H${n(size*2/3)}V${n(size*2/3)}H${n(size)}V${n(size)}Z" transform="translate(${x(u)} ${y(v)})" fill="${color}"/>`;
    // 大きな面は端を越えて配置し、矩形の枠ごとに分離しない。
    if (recipe === 0) {
      layers += circle(.10,-.03,radius,a);
      layers += polygon([[-.04,.34],[.27,1.10],[-.04,1.10]],c);
      layers += rect(.39,-.05,.16,.50,d);
      layers += polygon([[.50,1.08],[.85,-.08],[.85,1.08]],b);
      layers += circle(1.02,.10,radius*.91,c);
      layers += polygon([[.47,.50],[.47,1.06],[.64,1.06]],navy);
    } else if (recipe === 1) {
      layers += arc(.02,.04,radius*1.06,a);
      layers += rect(.28,-.08,.21,.43,d);
      layers += circle(.66,1.06,radius*.89,b);
      layers += polygon([[.69,-.05],[1.05,-.05],[1.05,1.05]],c);
      layers += staircase(.33,.60,Math.min(height*.70,width*.19),a);
      layers += polygon([[.84,.02],[1.04,.02],[1.04,.66]],navy);
    } else if (recipe === 2) {
      layers += polygon([[-.05,-.06],[.36,-.06],[-.05,1.10]],c);
      layers += circle(.99,.01,radius*1.08,a);
      layers += rect(.39,.65,.12,.45,d);
      layers += arc(.15,1.14,radius*.92,b);
      layers += polygon([[.56,-.05],[.77,-.05],[.35,1.05],[.14,1.05]],b);
      layers += polygon([[.68,.55],[.68,1.07],[.86,1.07]],navy);
    } else if (recipe === 3) {
      layers += circle(-.025,1.04,radius*1.18,a);
      layers += circle(1.02,-.06,radius*1.12,b);
      layers += polygon([[.27,-.05],[.62,-.05],[.27,.80]],d);
      layers += polygon([[.47,1.06],[.73,.38],[.73,1.06]],c);
      layers += rect(.52,.13,.095,.23,navy);
      layers += rect(.14,-.06,.10,.23,c);
    } else if (recipe === 4) {
      layers += staircase(-.02,.24,Math.min(height*.94,width*.25),a);
      layers += arc(.51,.53,Math.min(height*.65,width*.19),b);
      layers += polygon([[.66,1.05],[1.05,.20],[1.05,1.05]],d);
      layers += rect(.32,-.05,.11,.33,c);
      layers += rect(.58,.72,.18,.12,navy);
      layers += polygon([[.79,-.05],[.94,-.05],[.94,.46]],c);
    } else if (recipe === 5) {
      layers += rect(-.04,-.05,.29,.62,a);
      layers += circle(.25,.54,Math.min(height*.35,width*.13),paper);
      layers += polygon([[.28,1.06],[.58,-.05],[.72,-.05],[.42,1.06]],b);
      layers += polygon([[.58,-.05],[.70,-.05],[1.04,1.05],[.92,1.05]],d);
      layers += circle(1.03,.16,radius*.77,c);
      layers += rect(.63,.63,.07,.43,navy);
    } else if (recipe === 6) {
      layers += polygon([[.07,.22],[.24,-.18],[.41,.22],[.24,.70]],a);
      layers += polygon([[.40,.88],[.58,.39],[.76,.88],[.58,1.35]],b);
      layers += arc(1.01,.00,radius*.93,d);
      layers += rect(.70,.15,.21,.18,c);
      layers += polygon([[.05,.86],[.15,.60],[.25,.86],[.15,1.12]],navy);
      layers += rect(.45,-.06,.06,.22,d);
    } else if (recipe === 7) {
      layers += `<path d="M${x(.12)} ${y(1.07)}V${y(.43)}C${x(.12)} ${y(-.27)} ${x(.49)} ${y(-.27)} ${x(.49)} ${y(.43)}V${y(1.07)}Z" fill="${a}"/>`;
      layers += `<path d="M${x(.23)} ${y(1.08)}V${y(.49)}C${x(.23)} ${y(.16)} ${x(.38)} ${y(.16)} ${x(.38)} ${y(.49)}V${y(1.08)}Z" fill="${paper}"/>`;
      layers += polygon([[.57,-.05],[.92,1.05],[.57,1.05]],b);
      layers += circle(1.02,-.02,radius*.92,c);
      layers += rect(.46,.64,.28,.10,navy);
      layers += rect(.74,.17,.095,.28,d);
    } else if (recipe === 8) {
      layers += polygon([[-.05,.00],[.10,.00],[.43,1.05],[.28,1.05]],a);
      layers += polygon([[.26,-.05],[.40,-.05],[.73,1.05],[.59,1.05]],b);
      layers += polygon([[.61,-.05],[.72,-.05],[1.05,1.05],[.94,1.05]],c);
      layers += arc(.02,1.05,radius*.79,d);
      layers += rect(.76,.40,.11,.17,navy);
      layers += circle(.47,-.12,Math.min(height*.28,width*.09),d);
    } else if (recipe === 9) {
      layers += `<path d="M${x(-.03)} ${y(1.06)}V${y(-.07)}Q${x(.43)} ${y(-.07)} ${x(.43)} ${y(1.06)}Z" fill="${a}"/>`;
      layers += circle(.03,1.08,radius*.44,paper);
      layers += rect(.63,-.04,.30,.38,b);
      layers += polygon([[.57,.69],[.70,.35],[.83,.69]],c);
      layers += circle(.94,1.04,Math.min(height*.40,width*.13),d);
      layers += staircase(.47,.64,Math.min(height*.43,width*.12),navy);
    }
    // 斜線は形の外へ伸ばす。大きな色面の上にも同じ線が連続する。
    const hatchSlots = [[.03,-.13,38],[.51,.11,-38],[.03,-.13,38],[.69,.61,-38],[.05,-.08,23],[.30,.52,-30],[.67,.59,35],[.02,.17,38],[.41,-.08,38],[.67,.44,-38]];
    const [hatchX,hatchY,hatchAngle] = hatchSlots[recipe];
    const lineX = x(hatchX), lineY = y(hatchY);
    const run = Math.min(width*.33,height*1.37), gap = Math.min(19,height*.08);
    layers += `<g transform="translate(${lineX} ${lineY}) rotate(${hatchAngle})" fill="none" stroke="${navy}" stroke-width="2.2">`;
    for (let i=0;i<6;i++) layers += `<path d="M0 ${n(i*gap)}H${n(run)}"/>`;
    layers += '</g>';
    // 中くらいの図形は均等間隔を避け、大きな面と余白の境に置く。
    const medium = Math.min(height*.28,width*.087), mx=x(mix(.70,.79)), my=y(mix(.63,.76));
    if (recipe===0) layers += `<rect x="${n(-medium/2)}" y="${n(-medium/2)}" width="${n(medium)}" height="${n(medium)}" transform="translate(${mx} ${my}) rotate(45)" fill="${a}"/>`;
    else if (recipe===1) layers += polygon([[.13,.62],[.24,.95],[.13,.95]],c);
    else if (recipe===2) layers += staircase(.74,.57,medium*1.9,d);
    // 点群は面を埋めるためではなく、余白に置く小さなアクセント。
    const dotSlots = [[.32,.61],[.80,.71],[.86,.76],[.37,.73],[.72,.22],[.31,.13],[.47,.14],[.86,.70],[.43,.69],[.47,.23]];
    const dotX=x(dotSlots[recipe][0]), dotY=y(dotSlots[recipe][1]);
    const dotGap=Math.min(21,height*.10), dotRadius=Math.min(3.2,height*.015);
    layers += `<g fill="${navy}">`;
    for(let row=0;row<3;row++)for(let col=0;col<3;col++)layers += `<circle cx="${n(dotX+col*dotGap)}" cy="${n(dotY+row*dotGap)}" r="${n(dotRadius)}"/>`;
    layers += '</g>';
    // 色面と細線を同じ座標系で反転するため、配置全体の一貫性が保たれる。
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid slice" aria-hidden="true" data-cover-version="${version}" data-cover-seed="${seed}" data-composition="${recipe}"><rect width="${width}" height="${height}" fill="${paper}"/><g${mirror?` transform="translate(${width} 0) scale(-1 1)"`:''}>${layers}</g></svg>`;
  }
  return Object.freeze({render,version,patterns,pickPattern});
})();
