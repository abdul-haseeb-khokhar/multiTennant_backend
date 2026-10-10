import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';

/** `skip` / `take` over the messages of the visitor's conversation (oldest first). */
export class QueryWidgetConversationDto extends PaginationQueryDto {}
