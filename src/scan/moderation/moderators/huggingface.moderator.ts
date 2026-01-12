// import axios from 'axios';
// import { IModerator, ModerationResult } from './moderator.interface';

// export class HuggingFaceModerator implements IModerator {
//   constructor(
//     private token: string,
//     private model = 'Falconsai/nsfw_image_detection', // .env HF_MODEL
//   ) {}

//   async check(imageUrl: string): Promise<ModerationResult> {
//     const { data } = await axios.post(
//       `https://api-inference.huggingface.co/models/${this.model}`,
//       { inputs: imageUrl },
//       {
//         headers: { Authorization: `Bearer ${this.token}` },
//         timeout: 30000,
//       },
//     );

//     // Ko‘p model quyidagi formatda qaytaradi:
//     // [[{label:'porn', score:0.97}, {label:'sexy', score:0.02}, ...]]
//     const arr = Array.isArray(data) ? data : [];
//     const first = Array.isArray(arr[0]) ? arr[0] : arr;

//     // Eng yuqori ball bilan labelni tanlaymiz
//     let top = { label: 'unknown', score: 0 };
//     for (const it of first) {
//       if (it?.score > top.score) top = it;
//     }

//     // NSFW bo‘lsa: porn/sexy/hentai kabi
//     const nsfwLabels = ['porn', 'sexy', 'hentai', 'erotica', 'nsfw'];
//     const label = nsfwLabels.includes(top.label) ? 'nsfw' : 'safe';

//     return { label, score: top.score, raw: data , provider: 'huggingface'};
//   }
// }
////// == rasmni yuklab olib jonatish 


import axios from 'axios';
import { IModerator, ModerationResult } from './moderator.interface';

export class HuggingFaceModerator implements IModerator {
  constructor(
    private token: string,
    private model = 'Falconsai/nsfw_image_detection', // .env HF_MODEL
  ) {}

  async check(imageUrl: string): Promise<ModerationResult> {
    try {
      // 1. Rasmni yuklab olish (buffer ko‘rinishida)
      const { data: imgBuffer, headers } = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
      });
 
      // 2. Rasmni HuggingFace API’ga yuborish
      const { data } = await axios.post(
        `https://api-inference.huggingface.co/models/${this.model}`,
        imgBuffer,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': headers['content-type'] || 'image/png',
          },
          timeout: 30000,
        },
      );

      // 3. Natijani tanlash
      const arr = Array.isArray(data) ? data : [];
      const first = Array.isArray(arr[0]) ? arr[0] : arr;

      let top = { label: 'unknown', score: 0 };
      for (const it of first) {
        if (it?.score > top.score) top = it;
      }

      const nsfwLabels = ['porn', 'sexy', 'hentai', 'erotica', 'nsfw'];
      const label = nsfwLabels.includes(top.label) ? 'nsfw' : 'safe';

      return { label, score: top.score, raw: data , provider: 'huggingface' };
    } catch (e: any) {
      return {
        label: 'error',
        score: null,
        raw: { error: e?.message || 'HuggingFace error' },
        provider: 'huggingface'
      };
    }
  }
}
