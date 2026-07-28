import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Site } from '../../site/entities/site.entity';
import { DocumentStatus } from '../enums/document-status.enum';

@Entity('documents')
export class Document {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  filename: string;

  @Column()
  filePath: string;

  @Column({ type: 'varchar', nullable: true })
  cloudinaryPublicId: string | null;

  @Column({
    type: 'enum',
    enum: DocumentStatus,
    default: DocumentStatus.PENDING,
  })
  status: DocumentStatus;

  @Column({ type: 'uuid' })
  siteId: string;

  @ManyToOne(() => Site, (site) => site.documents)
  @JoinColumn({ name: 'siteId' })
  site: Site;

  @CreateDateColumn()
  uploadedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  processedAt: Date | null;
}
