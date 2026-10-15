// Two short made-up lessons for the leak checks: one English, one Filipino. Each has clean cards and wrong answers
// next to ones that give their answer away, so the rules are tested on both languages.

export const EN_LESSON = {
  title: 'Photosynthesis basics',
  text: `Photosynthesis is the process plants use to turn light energy into chemical energy stored in sugar.

It takes place in the chloroplasts, which contain the green pigment chlorophyll.

Chlorophyll absorbs mostly red and blue light and reflects green light, which is why leaves look green.

Plants take in carbon dioxide through small pores called stomata and release oxygen as a by-product.

The light reactions happen in the thylakoid membranes and make ATP and NADPH.

The Calvin cycle happens in the stroma and uses ATP and NADPH to build glucose from carbon dioxide.

When stomata close on hot days, less carbon dioxide enters and photosynthesis slows down.`,
  keyTerms: ['Chlorophyll', 'Stomata', 'Calvin cycle'],
  cards: [
    { id: 1, kind: 'term', front: 'Chlorophyll', back: 'The green pigment in chloroplasts that absorbs red and blue light.', evidence: 'which contain the green pigment chlorophyll' },
    { id: 2, kind: 'term', front: 'Stomata', back: 'Small pores in leaves through which plants take in carbon dioxide.', evidence: 'through small pores called stomata' },
    // its definition names the term: blanked in the quiz
    { id: 3, kind: 'term', front: 'Calvin cycle', back: 'The Calvin cycle builds glucose from carbon dioxide in the stroma.', evidence: 'The Calvin cycle happens in the stroma' },
    { id: 4, kind: 'concept', front: 'Where do the light reactions take place?', back: 'In the thylakoid membranes.', evidence: 'The light reactions happen in the thylakoid membranes' },
    { id: 5, kind: 'concept', front: 'Why do leaves look green?', back: 'Chlorophyll reflects green light while absorbing red and blue light.', evidence: 'reflects green light, which is why leaves look green' },
    { id: 6, kind: 'concept', front: 'What happens to photosynthesis when stomata close on hot days?', back: 'It slows down because less carbon dioxide enters.', evidence: 'less carbon dioxide enters and photosynthesis slows down' },
    // rule a: the question holds its answer
    { id: 7, kind: 'concept', front: 'What gas do plants release as a by-product, oxygen?', back: 'Oxygen.', evidence: 'release oxygen as a by-product' },
    { id: 8, kind: 'concept', front: 'What do the light reactions make?', back: 'ATP and NADPH.', evidence: 'make ATP and NADPH' },
  ],
  distractors: {
    4: ['In the stroma of the chloroplast.', 'In the stomata of the leaf.', 'In the green pigment.'], // clean
    // tone: every wrong option is a reversal
    5: ['Chlorophyll never reflects any light at all.', 'Leaves do not contain chlorophyll in their cells.', 'Green light cannot reach the leaf surface.'],
    // length: the right answer is 8 words, these are 2
    6: ['It stops.', 'It doubles.', 'It reverses.'],
    8: ['Glucose and oxygen.', 'Carbon dioxide and water.', 'Chlorophyll and stomata.'], // clean
  },
};

export const FIL_LESSON = {
  title: 'Pag-unlad ng Wika',
  text: `Ang wika ay dinamiko dahil patuloy itong nagbabago kasabay ng pamumuhay at kultura.

Noong panahon ng kolonyalismo nagkaroon tayo ng mga salitang galing sa Espanyol at Ingles.

Ginagamit ang Wikang Filipino sa edukasyon upang mas madaling maipaliwanag ang mga konsepto.

Sa pamahalaan, ginagamit ito sa pagbibigay ng impormasyon at serbisyo sa mamamayan.

Ang Balarila ay ang aklat ng gramatika ng wikang pambansa na inilathala noong 1940.

Ang Abakada ay ang lumang alpabeto na may dalawampung titik.`,
  keyTerms: ['Balarila', 'Abakada', 'Wikang Pambansa'],
  cards: [
    { id: 11, kind: 'term', front: 'Balarila', back: 'Aklat ng gramatika na inilathala noong 1940.', evidence: 'ang aklat ng gramatika ng wikang pambansa na inilathala noong 1940' },
    { id: 12, kind: 'term', front: 'Abakada', back: 'Ang lumang alpabeto na may dalawampung titik.', evidence: 'ang lumang alpabeto na may dalawampung titik' },
    // rule d: "pambansang wika" is a form of "Wikang Pambansa"
    { id: 13, kind: 'term', front: 'Wikang Pambansa', back: 'Ang pambansang wika na ginagamit sa buong bansa.', evidence: 'ang aklat ng gramatika ng wikang pambansa' },
    { id: 14, kind: 'concept', front: 'Paano ginagamit ang Wikang Filipino sa edukasyon?', back: 'Upang mas madaling maipaliwanag ang mga konsepto.', evidence: 'upang mas madaling maipaliwanag ang mga konsepto' },
    { id: 15, kind: 'concept', front: 'Ano ang naging epekto ng kolonyalismo sa ating wika?', back: 'Nagkaroon tayo ng mga salitang galing sa Espanyol at Ingles.', evidence: 'nagkaroon tayo ng mga salitang galing sa Espanyol at Ingles' },
    { id: 16, kind: 'concept', front: 'Paano ginagamit ang Wikang Filipino sa pamahalaan?', back: 'Ginagamit ito sa pagbibigay ng impormasyon at serbisyo sa mamamayan.', evidence: 'ginagamit ito sa pagbibigay ng impormasyon at serbisyo sa mamamayan' },
    // rule k: the back only restates the front
    { id: 17, kind: 'concept', front: 'Bakit nagbabago ang wika kasabay ng pamumuhay at kultura?', back: 'Nagbabago ang wika kasabay ng pamumuhay at kultura.', evidence: 'patuloy itong nagbabago kasabay ng pamumuhay at kultura' },
  ],
  distractors: {
    // tone: the two reversals ("mahirapan", "itago") are dropped; one clean option is not enough for multiple choice
    14: ['Upang mahirapan ang mga mag-aaral sa pag-unawa ng aralin.', 'Upang itago ang mga konsepto sa mga mag-aaral.', 'Upang palitan ang mga aklat ng mga lumang salita.'],
    15: ['Nagkaroon tayo ng mga bagong batas mula sa Espanyol at Ingles.', 'Nagkaroon tayo ng mga salitang galing sa Tsino at Hapon.', 'Nagkaroon tayo ng bagong alpabeto mula sa Amerikano.'], // clean
    // opening: every wrong option starts "Malaking papel"
    16: ['Malaking papel ang Filipino sa pagbuo ng mga batas.', 'Malaking papel ang Filipino sa pangongolekta ng buwis.', 'Malaking papel ang Filipino sa ugnayan sa ibang bansa.'],
  },
};

export const distractorMap = (lesson) => new Map(Object.entries(lesson.distractors).map(([id, list]) => [Number(id), list]));
