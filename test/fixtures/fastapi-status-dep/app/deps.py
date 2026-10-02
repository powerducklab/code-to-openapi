from fastapi import Path

# Path parameters declared inside a dependency callable surface on the route that
# uses it, even when the dependency is referenced through a module attribute.
async def fetch_item(item_id: int = Path(..., ge=1)):
    return {"id": item_id}
