import { Allow, IsUUID } from 'class-validator';

export class VisitorStreamDto {
  @IsUUID()
  siteId: string;

  @Allow()
  pageUrl?: unknown;

  @Allow()
  pageTitle?: unknown;

  @Allow()
  pageContent?: unknown;
}
