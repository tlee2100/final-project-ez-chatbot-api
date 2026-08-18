import { Column, Entity, OneToMany, PrimaryColumn } from 'typeorm';
import { AutoMap } from '@automapper/classes';
import { Site } from './site.entity';

@Entity('industry_templates')
export class IndustryTemplate {
  @AutoMap()
  @PrimaryColumn({ type: 'varchar', length: 50 })
  id: string;

  @AutoMap(() => Object)
  @Column({ type: 'jsonb', default: '{}' })
  config: Record<string, unknown>;

  @OneToMany(() => Site, (site) => site.industryTemplateInfo)
  sites: Site[];
}
