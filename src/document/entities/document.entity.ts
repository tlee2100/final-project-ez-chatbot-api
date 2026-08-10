import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Site } from '../../site/entities/site.entity';
import { DocumentStatus } from '../enums/document-status.enum';
import { DocumentFileType } from '../enums/document-file-type.enum';
import { DocumentChunk } from './document-chunk.entity';

@Entity('documents')
export class Document {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  filename: string;

  @Column()
  filePath: string;

  @Index()
  @Column({
    type: 'enum',
    enum: DocumentFileType,
    default: DocumentFileType.TXT,
  })
  fileType: DocumentFileType;

  @Column({ type: 'integer', nullable: true })
  fileSizeBytes: number | null;

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

  @OneToMany(() => DocumentChunk, (chunk) => chunk.document)
  chunks: DocumentChunk[];

  @CreateDateColumn()
  uploadedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  processedAt: Date | null;
}
