/* tslint:disable:no-unused-variable */

import { TestBed, async, inject } from '@angular/core/testing';
import { ModerationService } from './moderation.service';

describe('Service: Moderation', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ModerationService]
    });
  });

  it('should ...', inject([ModerationService], (service: ModerationService) => {
    expect(service).toBeTruthy();
  }));
});
