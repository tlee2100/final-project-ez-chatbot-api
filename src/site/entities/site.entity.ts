import {
  Column,
  Entity,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';
import { AutoMap } from '@automapper/classes';
import { KnowledgeBaseStatus } from '../enums/knowledge-base-status.enum';
import { Document } from '../../document/entities/document.entity';

@Entity('sites')
export class Site {
  @AutoMap()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @AutoMap()
  @Column()
  name: string;

  @AutoMap()
  @Column()
  url: string;

  @AutoMap()
  @Column({ type: 'uuid', nullable: false })
  ownerId: string;

  @AutoMap(() => User)
  @ManyToOne(() => User, (user) => user.sites)
  @JoinColumn({ name: 'ownerId' })
  owner: User;

  @ManyToMany(() => User, (user) => user.assignedSites)
  @JoinTable({
    name: 'site_agents',
    joinColumn: {
      name: 'siteId',
      referencedColumnName: 'id',
    },
    inverseJoinColumn: {
      name: 'agentId',
      referencedColumnName: 'id',
    },
  })
  agents: User[];

  @AutoMap(() => String)
  @Column({
    type: 'enum',
    enum: KnowledgeBaseStatus,
    default: KnowledgeBaseStatus.PENDING,
  })
  knowledgeBaseStatus: KnowledgeBaseStatus;

  @OneToMany(() => Document, (document) => document.site)
  documents: Document[];
}
