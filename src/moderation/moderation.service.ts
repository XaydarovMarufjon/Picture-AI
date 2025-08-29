import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';

@Injectable()
export class ModerationService {
  private openai = new OpenAI({
    apiKey: "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",
  });

  async moderateImage(imageUrl: string) {
    const response = await this.openai.chat.completions.create({
      model: "gpt-4o-mini", // Vision model
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Rasmni tekshir: unda pornografiya, zo‘ravonlik yoki noqonuniy kontent bormi?" },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
    });

    return response.choices[0].message.content;
  }
}
